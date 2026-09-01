import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dshDir = join(root, "runtime", "dsh");
const dshCli = join(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const reviewerSource = join(root, "runtime", "dsh-profile", "presets", "reviewer");

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
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

async function waitForRoster(baseUrl, stderr) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      return await rpc(baseUrl, "agentPreset.list", {});
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`timed out waiting for dsh preset roster\n${stderr()}`);
}

test("the pinned dsh runtime discovers and mounts DeepLab's reviewer preset", { timeout: 150_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-dsh-presets-"));
  const dshHome = join(home, "dsh-home");
  const reviewerTarget = join(dshHome, ".agent-presets", "reviewer");
  await mkdir(dirname(reviewerTarget), { recursive: true });
  await cp(reviewerSource, reviewerTarget, { recursive: true });

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
    const roster = await waitForRoster(baseUrl, () => stderr);
    const reviewer = roster.presets.find((preset) => preset.id === "reviewer");
    assert(reviewer, `reviewer missing from roster: ${JSON.stringify(roster.presets)}`);
    assert.equal(reviewer.broken, undefined);
    assert.equal(reviewer.name, "DeepLab Reviewer");

    const session = await rpc(baseUrl, "session.create", {
      cwd: root,
      agentPreset: "reviewer",
    });
    assert.equal(session.agentPreset, "reviewer");
    assert.match(session.sessionId, /^session-/);
  } finally {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
    await rm(home, { recursive: true, force: true });
  }
});
