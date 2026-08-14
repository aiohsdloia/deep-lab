#!/usr/bin/env node
/**
 * Launcher for the bundled DeepSeek Harness (dsh) web sidecar.
 *
 * The app spawns the sidecar with cwd = the active workspace folder, but the dsh
 * CLI resolves its profile and `.env` from ITS launch cwd — so a bare `dsh`
 * invocation would die with "profile web not found" unless a profile happened to
 * exist in that workspace. This launcher re-anchors the CLI onto its own
 * directory: it computes its absolute path, chdirs there, then spawns the
 * bundled CLI bin, forwarding every argument (the app passes
 * `--profile web --host 127.0.0.1 --port <port>`).
 *
 * The app sets DSH_HOME to its app-private runtime root so the sidecar never
 * touches the user's own ~/.dsh, and injects provider keys through the
 * environment (inherited here untouched).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const args = process.argv.slice(2);

process.chdir(here);

const child = spawn(process.execPath, [cli, ...args], {
  stdio: "inherit",
});
// A spawn that fails (missing module, EACCES, …) fires `error`, NOT `exit` —
// without this handler the launcher sat silently and the app timed out waiting
// for a sidecar that would never come. Surface the cause on stderr (the host
// drains it into its debug log) and exit so the app can report it.
child.on("error", (err) => {
  console.error(`[dsh-launcher] spawn failed: ${err.message}`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
