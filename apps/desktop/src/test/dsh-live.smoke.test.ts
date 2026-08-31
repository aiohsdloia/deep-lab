// Live smoke test for DeepLab's DshRuntime against a real `dsh web` sidecar.
// Starts nothing itself: run `runtime/dsh/launcher.mjs --profile web --port 3089`
// first (or set DSH_SMOKE_URL). Skips when the server is unreachable, so the
// normal `pnpm test` run is unaffected.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DshRuntime, type RuntimeEvent } from "@deeplab/sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

const baseUrl = process.env.DSH_SMOKE_URL ?? "http://127.0.0.1:3089";

async function reachable(): Promise<boolean> {
  try {
    const r = await fetch(`${baseUrl}/`);
    return r.ok;
  } catch {
    return false;
  }
}

describe.skipIf(!(await reachable()))("DshRuntime live smoke", () => {
  it("connects, lists capabilities, creates a session, and reads history", async () => {
    const rt = new DshRuntime({
      baseUrl,
      directory: "/tmp/deeplab-smoke",
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    try {
      await rt.connect();
      expect(rt.getStatus()).toBe("ready");

      const providers = await rt.listProviders();
      expect(Array.isArray(providers)).toBe(true);

      const skills = await rt.listSkills();
      expect(Array.isArray(skills)).toBe(true);

      const sid = await rt.createSession("smoke");
      expect(typeof sid).toBe("string");
      expect(sid.length).toBeGreaterThan(0);

      const sessions = await rt.listSessions();
      expect(sessions.some((s) => s.id === sid)).toBe(true);

      const messages = await rt.getMessages(sid);
      expect(Array.isArray(messages)).toBe(true);

      const defaultModel = await rt.getDefaultModel();
      // dsh requires a configured provider; null is acceptable on a bare box.
      expect(defaultModel === null || typeof defaultModel === "string").toBe(true);
    } finally {
      rt.close();
    }
  }, 20_000);

  it.skipIf(process.env.DSH_MODEL_SMOKE !== "1")(
    "completes a credentialed model turn through the real dsh sidecar",
    async () => {
      const rt = new DshRuntime({
        baseUrl,
        directory: "/tmp/deeplab-model-smoke",
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      let unsubscribe: () => void = () => undefined;
      try {
        await rt.connect();
        const model = await rt.getDefaultModel();
        expect(model).not.toBeNull();

        const sid = await rt.createSession("model smoke");
        const events: RuntimeEvent[] = [];
        const idle = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("model turn timed out")), 90_000);
          unsubscribe = rt.onEvent((event) => {
            if (event.sessionId !== sid) return;
            events.push(event);
            if (event.type === "error") {
              clearTimeout(timer);
              reject(new Error(event.message));
            } else if (event.type === "session.idle") {
              clearTimeout(timer);
              resolve();
            }
          });
        });

        await rt.sendPrompt(
          sid,
          "Reply with exactly DEEPLAB_READY and no other text.",
          undefined,
          model,
        );
        await idle;

        const answer = events
          .filter((event) => event.type === "text.updated")
          .map((event) => event.text)
          .join("\n");
        expect(answer).toContain("DEEPLAB_READY");
      } finally {
        unsubscribe();
        rt.close();
      }
    },
    120_000,
  );

  it.skipIf(process.env.DSH_AGENT_SMOKE !== "1")(
    "runs a credentialed agent tool turn in an arbitrary workspace",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "deeplab-agent-smoke-"));
      const rt = new DshRuntime({
        baseUrl,
        directory: workspace,
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      let unsubscribe: () => void = () => undefined;
      try {
        await rt.connect();
        const model = await rt.getDefaultModel();
        expect(model).not.toBeNull();

        const sid = await rt.createSession("agent smoke");
        const toolEvents: RuntimeEvent[] = [];
        const idle = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("agent turn timed out")), 120_000);
          unsubscribe = rt.onEvent((event) => {
            if (event.sessionId !== sid) return;
            if (event.type === "tool.updated") toolEvents.push(event);
            if (event.type === "permission.asked") {
              void rt.replyPermission(event.requestId, "once").catch(reject);
            } else if (event.type === "error") {
              clearTimeout(timer);
              reject(new Error(event.message));
            } else if (event.type === "session.idle") {
              clearTimeout(timer);
              resolve();
            }
          });
        });

        await rt.sendPrompt(
          sid,
          "Use a workspace file-writing tool to create readiness.txt containing exactly DEEPLAB_AGENT_READY followed by a newline. Then verify the file and finish.",
          undefined,
          model,
        );
        await idle;

        expect(await readFile(join(workspace, "readiness.txt"), "utf8")).toBe(
          "DEEPLAB_AGENT_READY\n",
        );
        expect(toolEvents.some((event) => event.type === "tool.updated")).toBe(true);
      } finally {
        unsubscribe();
        rt.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
    150_000,
  );

  it("adds and removes a custom provider through the live dsh settings seam", async () => {
    const rt = new DshRuntime({
      baseUrl,
      directory: "/tmp/deeplab-provider-smoke",
      WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    const provider = "deeplab-smoke-local";
    try {
      await rt.connect();
      await rt.addCustomProvider(provider, {
        name: "DeepLab Smoke Local",
        npm: "",
        baseURL: "http://127.0.0.1:9/v1",
        apiKey: "smoke-only",
        models: ["deepseek-smoke"],
        contexts: { "deepseek-smoke": 65536 },
      });

      await expect(rt.listCustomProviderIds()).resolves.toContain(provider);
      await expect(rt.listProviders()).resolves.toContainEqual({
        id: provider,
        name: "DeepLab Smoke Local",
        models: [{ id: "deepseek-smoke", name: "deepseek-smoke" }],
      });

      await rt.removeCustomProvider(provider);
      await expect(rt.listCustomProviderIds()).resolves.not.toContain(provider);
    } finally {
      await rt.removeCustomProvider(provider).catch(() => undefined);
      rt.close();
    }
  }, 20_000);
});
