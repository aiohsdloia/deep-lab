// Live smoke test for DeepLab's DshRuntime against a real `dsh web` sidecar.
// Starts nothing itself: run `runtime/dsh/launcher.mjs --profile web --port 3089`
// first (or set DSH_SMOKE_URL). Skips when the server is unreachable, so the
// normal `pnpm test` run is unaffected.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DshRuntime } from "@deeplab/sdk";
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
