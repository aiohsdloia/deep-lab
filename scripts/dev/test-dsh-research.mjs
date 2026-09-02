import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const core = join(root, "runtime", "skills", "core");
const dshDir = join(root, "runtime", "dsh");
const dshCli = join(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const stages = {
  "ai4s-agent": [],
  "research-explorer": [],
  "literature-survey": ["references/00-incremental-execution.md", "templates/survey/main.tex"],
  "experiment-suite": ["references/00-incremental-execution.md", "figure_examples/style_kit.py"],
  "paper-writer": ["references/00-incremental-execution.md", "templates/paper/main.tex"],
};

async function skill(name) {
  return readFile(join(core, name, "SKILL.md"), "utf8");
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
}

async function rpc(baseUrl, method, payload) {
  const rpcId = crypto.randomUUID();
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  assert.equal(response.status, 200);
  const envelope = await response.json();
  assert.equal(envelope.rpcId, rpcId);
  assert.equal(envelope.result.ok, true, JSON.stringify(envelope.result.error));
  return envelope.result.value;
}

async function waitForDsh(baseUrl, stderr) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      return await rpc(baseUrl, "agentPreset.list", {});
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`timed out waiting for dsh\n${stderr()}`);
}

test("the complete research pipeline is bundled as dsh-compatible skills", async () => {
  for (const [name, required] of Object.entries(stages)) {
    const text = await skill(name);
    assert.match(text, /^---\r?\nname: /);
    assert.match(text, new RegExp(`^name: ${name}$`, "m"));
    assert.match(text, /## DeepLab \/ dsh (?:execution|orchestration) contract/);
    assert.doesNotMatch(text, /OpenCode|\.openlab/);
    for (const relative of required) {
      assert.ok(existsSync(join(core, name, relative)), `${name} is missing ${relative}`);
    }
  }
});

test("the meta-skill uses native dsh delegation and verifies stage outputs", async () => {
  const text = await skill("ai4s-agent");
  assert.match(text, /dsh's `subagent` tool/);
  assert.match(text, /`run_in_background: false`/);
  assert.match(text, /same assistant\s+turn/);
  assert.match(text, /inspect(?:ing)?\s+the required files/i);
  assert.match(text, /Never collapse the four skills into one agent run/);
  assert.match(text, /Do not invoke an external agent CLI/);
  assert.doesNotMatch(text, /claude --print/);
  for (const name of ["research-explorer", "literature-survey", "experiment-suite", "paper-writer"]) {
    assert.match(text, new RegExp(`\\b${name}\\b`));
  }
});

test("the slash command enters the same guarded pipeline", async () => {
  const text = await readFile(join(root, "runtime", "dsh-profile", "command", "research.md"), "utf8");
  assert.match(text, /`ai4s-agent`/);
  assert.match(text, /dedicated dsh\s+subagents/);
  assert.match(text, /never invent citations or measured results/i);
});

test("the pinned dsh runtime discovers all five deployed research skills", { timeout: 150_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-dsh-research-"));
  const dshHome = join(home, "dsh-home");
  const skillsTarget = join(dshHome, "skills");
  await mkdir(skillsTarget, { recursive: true });
  for (const name of Object.keys(stages)) {
    await cp(join(core, name), join(skillsTarget, name), { recursive: true });
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(
    process.execPath,
    [dshCli, "--profile", "web", "--host", "127.0.0.1", "--port", String(port), "--no-open"],
    {
      cwd: dshDir,
      windowsHide: true,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_AGENTS_HOME: join(dshHome, "agents"),
        XDG_CONFIG_HOME: join(home, "xdg-config"),
        XDG_DATA_HOME: join(home, "xdg-data"),
        XDG_CACHE_HOME: join(home, "xdg-cache"),
        XDG_STATE_HOME: join(home, "xdg-state"),
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

  try {
    await waitForDsh(baseUrl, () => stderr);
    const session = await rpc(baseUrl, "session.create", { cwd: root });
    const catalog = await rpc(baseUrl, "skill.list", { sessionId: session.sessionId });
    const discovered = new Set(catalog.skills.map((entry) => entry.name));
    for (const name of Object.keys(stages)) {
      assert(discovered.has(name), `${name} missing from dsh catalog: ${[...discovered].join(", ")}`);
    }
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await rm(home, { recursive: true, force: true });
  }
});
