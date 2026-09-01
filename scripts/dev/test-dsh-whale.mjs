import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dshDir = join(root, "runtime", "dsh");
const dshCli = join(dshDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const plugin = join(root, "runtime", "dsh-plugins", "whale-widget", "lib", "index.js");

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

async function waitForJson(url, stderr) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      // The sidecar is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for whale endpoint\n${stderr()}`);
}

test("the pinned dsh runtime mounts the bundled whale balance and usage plugin", { timeout: 150_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-dsh-whale-"));
  const dshHome = join(home, "dsh-home");
  const patch = join(home, "whale.patch.yml");
  await writeFile(
    patch,
    JSON.stringify([{ insert: [{ id: "deeplab-whale-widget", name: pathToFileURL(plugin).href }] }]),
  );
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(
    process.execPath,
    [dshCli, "--profile", "web", "--patch", patch, "--host", "127.0.0.1", "--port", String(port), "--no-open"],
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
    const balance = await waitForJson(`${base}/dsh-whale/balance.json`, () => stderr);
    assert.equal(balance.ok, false);
    assert.equal(balance.code, "NO_KEY");

    const lastTurn = await (await fetch(`${base}/dsh-whale/last-turn.json`)).json();
    assert.deepEqual(lastTurn, {
      ok: true,
      seq: 0,
      turn: null,
      amount: null,
      tokens: null,
      ts: null,
    });

    const updated = await fetch(`${base}/dsh-whale/size.json`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scale: 1.5, usageMode: "token" }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).usageMode, "token");
    assert.equal((await (await fetch(`${base}/dsh-whale/size.json`)).json()).usageMode, "token");

    const image = await fetch(`${base}/dsh-whale/image.png`);
    assert.equal(image.status, 200);
    assert.match(image.headers.get("content-type") ?? "", /^image\/png/);
    assert((await image.arrayBuffer()).byteLength > 100_000);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    await rm(home, { recursive: true, force: true });
  }
});
