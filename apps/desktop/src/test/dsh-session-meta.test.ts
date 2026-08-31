import { describe, expect, it, vi } from "vitest";
import { DshRuntime } from "@deeplab/sdk";

/**
 * dsh's `session.list` returns rows WITHOUT a top-level title — the
 * auto-generated name lives under `projections.values.title`. And it does NOT
 * filter archived sessions: the SDK must keep them hidden using dsh's persisted
 * `workspace.list` archivedSessionIds, or a deleted conversation reappears after
 * a reconnect/restart. These tests pin both behaviors.
 */
describe("DshRuntime session list meta", () => {
  function runtimeWith(handlers: Record<string, (payload: unknown) => unknown>) {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const method = (input as URL).pathname.split("/").pop() as string;
      const handler = handlers[method];
      const value = handler ? handler(body.payload) : {};
      const rpcId = body.rpcId ?? "0";
      return new Response(JSON.stringify({ type: "server-response", rpcId, result: { ok: true, value } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    return new DshRuntime({ baseUrl: "http://127.0.0.1:1", fetchImpl });
  }

  it("reads the auto-generated title from projections.values.title", async () => {
    const rt = runtimeWith({
      "session.list": () => ({
        items: [
          {
            sessionId: "s1",
            updatedAt: 1,
            running: false,
            blank: false,
            projections: { values: { title: "递归概念解释详解" } },
          },
          { sessionId: "s2", updatedAt: 2, running: false, blank: false },
        ],
      }),
      "workspace.list": () => ({ items: [], archivedSessionIds: [] }),
    });
    const sessions = await rt.listSessions();
    expect(sessions.map((s) => s.title)).toEqual(["递归概念解释详解", "s2"]);
  });

  it("keeps archived sessions out of the active list", async () => {
    const rt = runtimeWith({
      "session.list": () => ({
        items: [
          { sessionId: "a1", updatedAt: 1, running: false, blank: false },
          { sessionId: "a2", updatedAt: 2, running: false, blank: false },
          { sessionId: "a3", updatedAt: 3, running: false, blank: false },
        ],
      }),
      "workspace.list": () => ({
        items: [],
        archivedSessionIds: ["a2", "a3"],
      }),
    });
    const sessions = await rt.listSessions();
    expect(sessions.map((s) => s.id)).toEqual(["a1"]);
    expect(sessions[0]?.archived).toBeUndefined();
  });

  it("marks archived sessions and surfaces them on demand", async () => {
    const rt = runtimeWith({
      "session.list": () => ({
        items: [
          { sessionId: "a1", updatedAt: 1, running: false, blank: false },
          { sessionId: "a2", updatedAt: 2, running: false, blank: false },
        ],
      }),
      "workspace.list": () => ({ items: [], archivedSessionIds: ["a2"] }),
    });
    const active = await rt.querySessions({});
    expect(active.sessions.map((s) => s.id)).toEqual(["a1"]);
    const all = await rt.querySessions({ archived: true });
    expect(all.sessions.map((s) => s.id).sort()).toEqual(["a1", "a2"]);
    expect(all.sessions.find((s) => s.id === "a2")?.archived).toBeTypeOf("number");
  });
});

describe("DshRuntime history folding", () => {
  function runtimeWith(handlers: Record<string, (payload: unknown) => unknown>) {
    const fetchImpl = vi.fn(async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const method = (input as URL).pathname.split("/").pop() as string;
      const value = handlers[method] ? handlers[method]!(body.payload) : {};
      return new Response(
        JSON.stringify({ type: "server-response", rpcId: body.rpcId ?? "0", result: { ok: true, value } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    return new DshRuntime({ baseUrl: "http://127.0.0.1:1", fetchImpl });
  }

  it("drops system-injected user/message rows from history", async () => {
    const rt = runtimeWith({
      "session.history": () => ({
        events: [
          {
            event: {
              type: "user/message",
              data: {
                id: "u1",
                source: { kind: "user" },
                content: [{ type: "text", text: "请写一个三子棋" }],
              },
            },
          },
          {
            event: {
              type: "user/message",
              data: {
                id: "u2",
                source: { kind: "plugin" },
                content: [{ type: "text", text: "Current runtime context…" }],
              },
            },
          },
          {
            event: {
              type: "user/message",
              data: {
                id: "u3",
                source: { kind: "skill-catalog" },
                content: [{ type: "text", text: "<system-reminder>…" }],
              },
            },
          },
          {
            event: {
              type: "assistant/message",
              data: { message: { content: [{ type: "text", text: "好的" }] } },
            },
          },
        ],
      }),
    });
    const messages = await rt.getMessages("s1");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.parts).toEqual([{ type: "text", text: "请写一个三子棋" }]);
  });
});

describe("DshRuntime permission preset", () => {
  function runtimeCapture(resultFor?: (method: string) => unknown) {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ method: body.method, payload: body.payload });
      return new Response(
        JSON.stringify({
          type: "server-response",
          rpcId: body.rpcId ?? "0",
          result: { ok: true, value: resultFor?.(body.method) ?? {} },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const rt = new DshRuntime({ baseUrl: "http://127.0.0.1:1", fetchImpl });
    return { rt, calls };
  }

  it("reads and writes dsh's default permission preset directly", async () => {
    const { rt, calls } = runtimeCapture((method) =>
      method === "settings.describe"
        ? {
            namespaces: [
              { ns: "permission", value: { defaultPreset: "danger-full-access" } },
            ],
          }
        : undefined,
    );
    await expect(rt.getDefaultPermissionPreset()).resolves.toBe("danger-full-access");

    await rt.setDefaultPermissionPreset("workspace-write");
    expect(calls[calls.length - 1]).toEqual({
      method: "settings.update",
      payload: { ns: "permission", patch: { defaultPreset: "workspace-write" } },
    });
  });

  it("recovers a session's effective preset from its history projection", async () => {
    const { rt } = runtimeCapture((method) =>
      method === "session.history"
        ? {
            events: [],
            projections: {
              values: {
                permissions: {
                  options: ["workspace-write", "danger-full-access"],
                  currentValue: "danger-full-access",
                },
              },
            },
          }
        : undefined,
    );
    const events: unknown[] = [];
    rt.onEvent((event) => events.push(event));
    await rt.getMessages("s1");
    expect(events).toContainEqual({
      type: "permission.preset.updated",
      sessionId: "s1",
      preset: "danger-full-access",
    });
  });

  it("switches an existing session through dsh's native slash command", async () => {
    const { rt, calls } = runtimeCapture((method) =>
      method === "session.prompt" ? { accepted: true, command: { kind: "success" } } : undefined,
    );
    await rt.setSessionPermissionPreset("s1", "danger-full-access");
    expect(calls[calls.length - 1]).toEqual({
      method: "session.prompt",
      payload: {
        sessionId: "s1",
        mode: "queue",
        content: [{ type: "text", text: "/permission danger-full-access" }],
      },
    });
  });

  it("rejects a permission command that dsh does not accept", async () => {
    const { rt, calls } = runtimeCapture();
    await expect(rt.setSessionPermissionPreset("s1", "workspace-write")).rejects.toThrow(
      "did not confirm",
    );
    expect(calls[calls.length - 1]?.method).toBe("session.prompt");
  });
});
