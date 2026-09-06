import { cp, mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dshDir = join(repo, "runtime", "dsh");
const dshCli = join(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const appDshHome = join(
  process.env.APPDATA,
  "com.sculab.deeplab",
  "runtime",
  "dsh-home",
);
const seedCsv = join(repo, "examples", "climate-trends", "data", "gistemp_global_means.csv");

const ARGS = parseArgs(process.argv.slice(2));
const smoke = ARGS.smoke;
const fidelity = ARGS.fidelity;
const keep = ARGS.keep;
const mode = smoke ? "smoke" : fidelity ? "fidelity" : "full";
const workRoot = join(
  ARGS.work || tmpdir(),
  `deeplab-rp-${mode}`,
);

const statusPath = join(workRoot, "status.json");
const logPath = join(workRoot, "run.log");

function parseArgs(argv) {
  const out = { smoke: false, keep: false, work: undefined, fidelity: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--smoke") out.smoke = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--work") out.work = argv[++i];
    else if (a === "--fidelity") out.fidelity = true;
  }
  return out;
}

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  process.stdout.write(line + "\n");
  try {
    writeFile(logPath, line + "\n", { flag: "a" }).catch(() => undefined);
  } catch {}
}

function status(partial) {
  let current = {};
  if (existsSync(statusPath)) {
    try {
      current = JSON.parse(readFileSync(statusPath, "utf8"));
    } catch {
      current = {};
    }
  }
  const next = { ...current, ...partial };
  if (!next.startedAt) next.startedAt = new Date().toISOString();
  mkdirSync(dirname(statusPath), { recursive: true });
  writeFileSync(statusPath, JSON.stringify(next, null, 2));
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve2);
  });
  const address = server.address();
  await new Promise((resolve2, reject) =>
    server.close((error) => (error ? reject(error) : resolve2())),
  );
  return address.port;
}

let rpcSeq = 0;
async function rpc(baseUrl, method, payload) {
  const rpcId = `${Date.now()}-${++rpcSeq}`;
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for /api/${method}`);
  const envelope = await response.json();
  if (envelope.rpcId !== rpcId) throw new Error(`rpcId mismatch for ${method}`);
  if (!envelope.result.ok) {
    const error = envelope.result.error || {};
    throw new Error(`${method} failed: ${error.message || JSON.stringify(error)}`);
  }
  return envelope.result.value;
}

async function respond(baseUrl, rpcId, value) {
  const response = await fetch(`${baseUrl}/api/respond`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value } }),
  });
  if (!response.ok) throw new Error(`respond HTTP ${response.status}`);
  const receipt = await response.json();
  if (!receipt.accepted) throw new Error(`response rejected (${receipt.reason})`);
}

async function waitForDsh(baseUrl, stderrLines) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      await rpc(baseUrl, "agentPreset.list", {});
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`timed out waiting for dsh\n${stderrLines()}`);
}

async function prepareWorkspace() {
  await rm(workRoot, { recursive: true, force: true });
  const project = join(workRoot, "project");
  const dataDir = join(project, "data");
  await mkdir(dataDir, { recursive: true });
  await copyFile(seedCsv, join(dataDir, "gistemp_global_means.csv"));
  const homeCopy = join(workRoot, "dsh-home");
  await cp(appDshHome, homeCopy, { recursive: true });
  for (const d of ["xdg-config", "xdg-data", "xdg-cache", "xdg-state"]) {
    await mkdir(join(workRoot, d), { recursive: true });
  }
  await mkdir(join(homeCopy, "agents"), { recursive: true });
  return { project, homeCopy };
}

function openStreams(baseUrl, sessionId, onServerRequest) {
  const sockets = [];
  for (const path of ["/api/events.mux", "/api/events.host"]) {
    const ws = new WebSocket(`${baseUrl}${path}`);
    ws.addEventListener("message", (event) => {
      let envelope;
      try {
        envelope = JSON.parse(String(event.data));
      } catch {
        return;
      }
      onServerRequest(envelope, path);
    });
    sockets.push(ws);
  }
  return sockets;
}

async function selectModel(baseUrl, sessionId) {
  const models = await rpc(baseUrl, "session.models", { sessionId });
  if (models.current && models.routable) return models.current;
  const group = (models.groups || []).find((g) => g.id === "deepseek-official");
  const candidate = group?.models?.[0];
  if (!candidate) throw new Error("no routable model; configure a provider first");
  const selection = { provider: group.id, model: candidate.id };
  await rpc(baseUrl, "session.selectModel", { sessionId, ...selection });
  return selection;
}

function summarizeEvent(event) {
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant/message":
      return `assistant: ${String(data?.message?.content?.[0]?.text ?? "").slice(0, 90).replace(/\s+/g, " ")}`;
    case "tool/call":
      return `tool ${data.name}`;
    case "tool/result":
      return `tool-result ${data?.message?.isError ? "ERROR" : "ok"}`;
    case "turn/end":
      return "turn/end";
    default:
      return event.type;
  }
}

function buildTask(project, mode2) {
  if (mode2 === "smoke") return "Reply with exactly: smoke-ok";
  const base = [
    `You are in workspace ${project}. Follow the bundled \`ai4s-agent\` skill and execute its full five-stage research pipeline for this BOUNDED study:`,
    `Stage 1+2: read data/gistemp_global_means.csv; write research/exploration.md (question + method) and research/literature-notes.md. For literature, do NOT invent citations: write a methodology note listing what a real corpus search would do and mark all entries as placeholders unless the workspace already provides sources.`,
    `Stage 3+4: write experiment/analysis.py that is DEPENDENCY-FREE python3 (stdlib only) and computes the global temperature linear trend from the CSV (year column x, anomaly y), fits slope/CI, writes experiment/results.json with the measured numbers AND experiment/figure.svg (a simple hand-built SVG line + fit chart). Then RUN it with the bash tool (python exists on PATH) and fix until it passes. Never claim measured results the run did not produce.`,
    `Stage 5: write report/report.md summarizing method, the MEASURED numbers from experiment/results.json, referencing the exact files produced, and stating limitations.`,
  ].join("\n");
  if (mode2 === "fidelity") {
    return [
      base,
      "FIDELITY REQUIREMENT: delegate EACH of the five stages to a SEPARATE dedicated dsh subagent via the `subagent` tool (one subagent per stage), run_in_background false, and wait for each before the next. Do the file work through those subagents, not inline yourself.",
      "If the `subagent` tool is NOT available to you in this runtime, do not fake it: finish the run inline and end your final summary with the exact token SUBAGENT-TOOL-UNAVAILABLE.",
    ].join("\n");
  }
  return base;
}

async function runPipeline({ baseUrl, sessionId, project, task }) {
  const tail = new Map();
  const turnsEnded = [];
  const approvals = [];
  const questions = [];
  const toolCalls = [];
  const assistantTexts = [];
  const started = Date.now();

  status({ phase: "prompted", sessionId, startedAt: new Date().toISOString() });

  await rpc(baseUrl, "session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: task }],
  });

  const streams = openStreams(baseUrl, sessionId, async (envelope, path) => {
    if (!envelope || envelope.type !== "server-request") return;
    const frame = envelope.payload;
    if (!frame) return;
    if (path === "/api/events.mux") {
      if (frame.type === "session/event" && frame.sessionId === sessionId) {
        const event = frame.event;
        const key = summarizeEvent(event);
        const at = new Date().toISOString().slice(11, 23);
        tail.set(key, at);
        if (event.type === "turn/end") turnsEnded.push(Date.now());
        else if (event.type === "assistant/message") {
          for (const block of event.data?.message?.content ?? []) {
            if (block.type === "text" && typeof block.text === "string") assistantTexts.push(block.text);
          }
        } else if (event.type === "tool/call" && typeof event.data?.name === "string") {
          toolCalls.push(event.data.name);
        }
      } else if (frame.type === "approval/requested") {
        approvals.push({ toolName: frame.toolName, reason: frame.reason });
        log(`[auto-allow] ${frame.toolName} ${frame.reason ?? ""}`);
        try {
          await respond(baseUrl, envelope.rpcId, {
            sessionId,
            approvalId: frame.approvalId,
            outcome: "allowed-once",
          });
        } catch (error) {
          log(`[auto-allow failed] ${error.message}`);
        }
      } else if (frame.type === "question/requested") {
        questions.push(frame.questions.map((q) => q.question).join(" | "));
        const answers = (frame.questions ?? []).map((q) => ({
          id: q.id,
          selected: q.options?.length ? [q.options[0].label] : [],
          custom: q.options?.length ? undefined : "Proceed with your best judgment",
        }));
        log(`[auto-answer] ${questions.at(-1)}`);
        try {
          await respond(baseUrl, envelope.rpcId, { sessionId, answer: { answers } });
        } catch (error) {
          log(`[auto-answer failed] ${error.message}`);
        }
      }
    }
  });

  const deadline = Date.now() + (smoke ? 180_000 : 45 * 60_000);
  let lastTurnEnd = 0;
  let finished = false;
  while (Date.now() < deadline) {
    if (turnsEnded.length > 0) lastTurnEnd = turnsEnded[turnsEnded.length - 1];
    if (lastTurnEnd > 0 && Date.now() - lastTurnEnd > 10_000) {
      const listing = await rpc(baseUrl, "session.list", {}).catch(() => null);
      const row = listing?.items?.find((s) => s.sessionId === sessionId);
      if (row && !row.running) {
        finished = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 4000));
  }

  for (const ws of streams) ws.close();
  return {
    finished,
    elapsedSec: Math.round((Date.now() - started) / 1000),
    approvals,
    questions,
    tail,
    toolCalls,
    assistantTexts,
  };
}

async function verifyArtifacts(project, smokeMode) {
  const expected = smokeMode
    ? []
    : [
        ["research/exploration.md", 200],
        ["research/literature-notes.md", 200],
        ["experiment/analysis.py", 300],
        ["experiment/results.json", 50],
        ["experiment/figure.svg", 200],
        ["report/report.md", 300],
      ];
  const found = [];
  for (const [rel, min] of expected) {
    const full = join(project, rel);
    if (!existsSync(full)) {
      found.push({ rel, ok: false, reason: "missing" });
      continue;
    }
    const size = (await readFile(full)).length;
    found.push({ rel, ok: size >= min, size });
  }
  return found;
}

async function main() {
  log(`mode=${mode} work=${workRoot}`);
  status({ phase: "preparing", mode });
  const { project, homeCopy } = await prepareWorkspace();

  let stderr = "";
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [dshCli, "--profile", "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"],
    {
      cwd: dshDir,
      windowsHide: true,
      env: {
        ...process.env,
        DSH_HOME: homeCopy,
        DSH_AGENTS_HOME: join(homeCopy, "agents"),
        XDG_CONFIG_HOME: join(workRoot, "xdg-config"),
        XDG_DATA_HOME: join(workRoot, "xdg-data"),
        XDG_CACHE_HOME: join(workRoot, "xdg-cache"),
        XDG_STATE_HOME: join(workRoot, "xdg-state"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForDsh(baseUrl, () => stderr);
    log("dsh ready");
    const created = await rpc(baseUrl, "session.create", { cwd: project });
    const sessionId = created.sessionId;
    const model = await selectModel(baseUrl, sessionId);
    log(`session ${sessionId} model ${model.provider}/${model.model}`);

    const catalog = await rpc(baseUrl, "skill.list", { sessionId });
    const names = catalog.skills.map((s) => s.name);
    status({ phase: "skills", sessionId, skills: names });
    log(`skills: ${names.join(", ")}`);

    const result = await runPipeline({ baseUrl, sessionId, project, task: buildTask(project, mode) });
    const artifacts = await verifyArtifacts(project, smoke);
    const subagentUsed = (result.toolCalls ?? []).includes("subagent");
    const unavailable =
      (result.assistantTexts ?? []).some((t) => t.includes("SUBAGENT-TOOL-UNAVAILABLE"));
    const fidelityMet = mode !== "fidelity" || (subagentUsed && !unavailable);

    const ok =
      result.finished &&
      artifacts.every((a) => a.ok) &&
      (smoke || !result.questions.length) &&
      fidelityMet;
    status({
      phase: "done",
      mode,
      ok,
      finished: result.finished,
      subagentUsed,
      subagentUnavailable: unavailable,
      elapsedSec: result.elapsedSec,
      approvals: result.approvals.length,
      questions: result.questions,
      toolCalls: [...new Set(result.toolCalls ?? [])],
      tail: Object.fromEntries(result.tail),
      artifacts,
      project,
    });
    log(JSON.stringify({ ok, mode, finished: result.finished, subagentUsed, subagentUnavailable: unavailable, elapsedSec: result.elapsedSec, approvals: result.approvals.length, questions: result.questions, toolCalls: [...new Set(result.toolCalls ?? [])], artifacts }, null, 2));
  } catch (error) {
    status({ phase: "error", error: String(error?.message ?? error) });
    log(`error: ${error?.stack ?? error}`);
  } finally {
    child.kill();
    await Promise.race([
      new Promise((r) => child.once("exit", r)),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
    if (!keep && !smoke) {
      log(`run complete; workspace kept at ${workRoot}`);
    } else if (keep) {
      log(`--keep set; workspace kept at ${workRoot}`);
    } else {
      log(`smoke workspace kept at ${workRoot}`);
    }
  }
}

main();
