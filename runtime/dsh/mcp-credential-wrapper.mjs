#!/usr/bin/env node
/**
 * Launch a stdio MCP server with values resolved from dsh's managed credential
 * document. Cordis receives reference names only; secret values never enter the
 * patch file, command line, or logs.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { spawn } from "node:child_process";

const require = createRequire(import.meta.url);
const dshPackage = require.resolve("@deepseek-ai/dsh/package.json");
const dshRequire = createRequire(dshPackage);
const { load } = dshRequire("js-yaml");

const separator = process.argv.indexOf("--", 2);
if (separator < 0 || separator === process.argv.length - 1) {
  console.error("[deeplab-mcp] expected -- followed by an MCP command");
  process.exit(2);
}

const dshHome = process.env.DSH_HOME;
if (!dshHome) {
  console.error("[deeplab-mcp] DSH_HOME is not set");
  process.exit(2);
}

let refs;
try {
  refs = JSON.parse(process.env.DEEPLAB_MCP_CREDENTIAL_REFS ?? "[]");
  if (!Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) {
    throw new TypeError("credential references must be a string array");
  }
} catch (error) {
  console.error(`[deeplab-mcp] invalid credential reference list: ${error.message}`);
  process.exit(2);
}

let document;
try {
  const text = await readFile(join(dshHome, ".credentials.yaml"), "utf8");
  document = load(text);
} catch (error) {
  console.error(`[deeplab-mcp] could not read the managed credential document: ${error.code ?? error.message}`);
  process.exit(1);
}

if (
  !document ||
  document.version !== 1 ||
  !document.refs ||
  typeof document.refs !== "object" ||
  Array.isArray(document.refs)
) {
  console.error("[deeplab-mcp] managed credential document has an unsupported shape");
  process.exit(1);
}

const env = { ...process.env };
delete env.DEEPLAB_MCP_CREDENTIAL_REFS;
for (const ref of refs) {
  const value = document.refs[ref];
  if (typeof value !== "string" || value.length === 0) {
    console.error(`[deeplab-mcp] required credential ${ref} is not configured`);
    process.exit(1);
  }
  env[ref] = value;
}

const [command, ...args] = process.argv.slice(separator + 1);
const child = spawn(command, args, {
  env,
  stdio: "inherit",
  windowsHide: true,
});

child.on("error", (error) => {
  console.error(`[deeplab-mcp] failed to start MCP server: ${error.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
