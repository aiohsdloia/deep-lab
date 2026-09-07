// Run against the desktop executable OR the lightweight production-source
// harness. No model, provider key, or copied dsh home is needed.
// node scripts/dev/test-browser-proxy.mjs <proxy.exe> <agent-browser.exe>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";

const [proxy, browser] = process.argv.slice(2);
assert(proxy && browser, "expected proxy executable and agent-browser executable");
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>DeepLab Proxy Acceptance</title><h1>Ready</h1>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn(proxy, ["--browser-mcp", browser, "mcp", "--tools", "all"], {
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let sequence = 0;
let diagnostics = "";
child.stderr.on("data", (data) => { diagnostics = (diagnostics + data).slice(-12000); });
const exited = new Promise((resolve) => child.on("exit", resolve));
child.on("error", (error) => {
  for (const { reject } of pending.values()) reject(error);
});
child.on("exit", (code) => {
  for (const { reject } of pending.values()) reject(new Error(`proxy exited ${code}: ${diagnostics}`));
});
createInterface({ input: child.stdout }).on("line", (line) => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  if (!waiter) return;
  pending.delete(response.id);
  clearTimeout(waiter.timer);
  if (response.error) waiter.reject(new Error(JSON.stringify(response.error)));
  else waiter.resolve(response.result);
});

function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${diagnostics}`));
    }, 55000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

async function call(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

try {
  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "deeplab-proxy-acceptance", version: "1" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const catalog = await rpc("tools/list", {});
  assert(catalog.tools.some((tool) => tool.name === "agent_browser_inventory"));
  assert(!catalog.tools.some((tool) => tool.name === "agent_browser_connect"));
  console.log("PASS: initialize and protected tools/list");
  const before = JSON.parse(await call("agent_browser_inventory"));
  assert.equal(before.currentConversation.browserOpen, false);
  console.log("PASS: inventory without caller-supplied lease");
  const blocked = await rpc("tools/call", { name: "agent_browser_connect", arguments: {} });
  assert.equal(blocked.isError, true);
  console.log("PASS: direct invocation of hidden ownership tool rejected");
  // A loopback fixture removes Internet/provider variability from acceptance.
  await call("agent_browser_open", { url: `http://127.0.0.1:${server.address().port}` });
  const after = JSON.parse(await call("agent_browser_inventory"));
  assert.equal(after.currentConversation.browserOpen, true);
  assert.match(JSON.stringify(after.currentConversation.tabs), /127\.0\.0\.1/);
  console.log("PASS: browser open and inventory agree on ownership");
  await call("agent_browser_wait_ms", { ms: 50 });
  assert.match(await call("agent_browser_get_title"), /DeepLab Proxy Acceptance/);
  console.log("PASS: follow-up wait and real page title");
  await call("agent_browser_close");
  const closed = JSON.parse(await call("agent_browser_inventory"));
  assert.equal(closed.currentConversation.browserOpen, false);
  console.log("PASS: close and inventory agree; no browser left by acceptance");
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  server.closeAllConnections();
  server.close();
  if (child.exitCode === null) {
    await call("agent_browser_close").catch(() => {});
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timer);
  }
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
}
