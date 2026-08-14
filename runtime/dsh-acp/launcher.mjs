#!/usr/bin/env node
/**
 * Launcher for the bundled DeepSeek Harness ACP automation server.
 *
 * The app spawns ACP agents with cwd = the active workspace folder, but the dsh
 * demo bin resolves `cordis.yml` (and loads `.env`) from ITS launch cwd — so a
 * bare `dsh-acp-demo` invocation dies with "config file not found" unless a
 * cordis.yml happens to exist in that workspace. This launcher re-anchors the
 * demo onto its own directory: it computes its absolute path, chdirs there, then
 * execs the bundled demo bin with `--config <abs cordis.yml>`. The API key is
 * inherited from the environment, which the app injects from the user's own
 * credential store at spawn time.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const demo = join(here, "node_modules", "@deepseek-ai", "dsh-acp-demo", "lib", "bin.js");
const config = join(here, "cordis.yml");

process.chdir(here);

const child = spawn(process.execPath, [demo, "--config", config], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
