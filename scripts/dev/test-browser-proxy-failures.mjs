// node scripts/dev/test-browser-proxy-failures.mjs <proxy.exe> <fixture.exe>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const [proxy, fixture] = process.argv.slice(2);
assert(proxy && fixture, "expected proxy and fixture executables");
const directory = await mkdtemp(join(tmpdir(), "deeplab-proxy-failures-"));
try {
  for (const mode of ["eof", "hang"]) {
    const pidFile = join(directory, `${mode}.pid`);
    const child = spawn(proxy, ["--browser-mcp", fixture, "mcp"], {
      windowsHide: true,
      env: { ...process.env, DEEPLAB_FIXTURE_MODE: mode, DEEPLAB_FIXTURE_PID_FILE: pidFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses = [];
    child.stderr.resume();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const response = JSON.parse(line);
      responses.push(response);
      if (response.id === 1) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call",
          params: { name: "agent_browser_wait_ms", arguments: { ms: 10 } } }) + "\n");
      }
    });
    const started = performance.now();
    const timer = setTimeout(() => child.kill(), 42000);
    const exited = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n");
    const code = await exited;
    clearTimeout(timer);
    assert.equal(code, 1, "proxy should fail promptly so dsh can reconnect");
    const response = responses.find((value) => value.id === 2);
    assert.equal(response?.error?.code, -32000);
    assert.match(response.error.message, mode === "hang" ? /timed out/ : /exited unexpectedly/);
    const backendPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(backendPid, 0), "backend must be reaped on failure");
    console.log(`PASS: ${mode} returned a correlated error and reaped its backend in ${Math.round(performance.now() - started)}ms`);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
