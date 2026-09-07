import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const wrapper = join(root, "runtime", "dsh", "mcp-credential-wrapper.mjs");
const dshCli = join(
  root,
  "runtime",
  "dsh",
  "node_modules",
  "@deepseek-ai",
  "dsh",
  "lib",
  "bin.js",
);

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("injects managed credential refs into only the MCP child", async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-mcp-wrapper-"));
  try {
    await writeFile(
      join(home, ".credentials.yaml"),
      '{"version":1,"refs":{"DEEPLAB_TEST_KEY":"wrapper-ok"}}',
    );
    const result = await run(
      process.execPath,
      [
        wrapper,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(process.env.DEEPLAB_TEST_KEY ?? 'missing')",
      ],
      {
        ...process.env,
        DSH_HOME: home,
        DEEPLAB_MCP_CREDENTIAL_REFS: '["DEEPLAB_TEST_KEY"]',
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "wrapper-ok");
    assert.equal(result.stderr, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("fails without printing a missing credential value", async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-mcp-wrapper-"));
  try {
    await writeFile(join(home, ".credentials.yaml"), '{"version":1,"refs":{}}');
    const result = await run(process.execPath, [wrapper, "--", process.execPath, "-e", ""], {
      ...process.env,
      DSH_HOME: home,
      DEEPLAB_MCP_CREDENTIAL_REFS: '["ABSENT_KEY"]',
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /required credential ABSENT_KEY is not configured/);
    assert.doesNotMatch(result.stderr, /undefined|null/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("recovers app-owned browser parameters from a stale credential document", async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-mcp-wrapper-"));
  try {
    await writeFile(join(home, ".credentials.yaml"), '{"version":1,"refs":{}}');
    const result = await run(
      process.execPath,
      [
        wrapper,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({ namespace: process.env.AGENT_BROWSER_NAMESPACE, idle: process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS, headed: process.env.AGENT_BROWSER_HEADED }))",
      ],
      {
        ...process.env,
        DSH_HOME: home,
        DEEPLAB_MCP_CREDENTIAL_REFS:
          '["AGENT_BROWSER_NAMESPACE","AGENT_BROWSER_IDLE_TIMEOUT_MS","AGENT_BROWSER_HEADED"]',
      },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      namespace: "open-science-desktop",
      idle: "600000",
      headed: "true",
    });
    assert.equal(result.stderr, "");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the pinned dsh CLI accepts DeepLab's MCP Cordis patch shape", async () => {
  const home = await mkdtemp(join(tmpdir(), "deeplab-mcp-patch-"));
  try {
    const patch = join(home, "mcp.patch.yml");
    await writeFile(
      patch,
      JSON.stringify([
        {
          insert: [
            {
              id: "deeplab-mcp-contract-test",
              name: "@deepseek-ai/dsh-mcp-client",
              config: {
                serverName: "contract-test",
                transport: "stdio",
                command: process.execPath,
                args: ["-e", "process.exit(0)"],
              },
            },
          ],
        },
      ]),
    );
    const result = await run(
      process.execPath,
      [dshCli, "--profile", "web", "--patch", patch, "--dump-config"],
      { ...process.env, DSH_HOME: home },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /id: deeplab-mcp-contract-test/);
    assert.match(result.stdout, /name: '@deepseek-ai\/dsh-mcp-client'/);
    assert.match(result.stdout, /serverName: contract-test/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
