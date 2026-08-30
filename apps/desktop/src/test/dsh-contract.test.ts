import { describe, expect, it, vi } from "vitest";
import { DshRuntime } from "@deeplab/sdk";

type Handler = (payload: Record<string, unknown>) => unknown;

function runtimeWith(
  handlers: Record<string, Handler>,
  mcpConfigHost?: ConstructorParameters<typeof DshRuntime>[0]["mcpConfigHost"],
) {
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      rpcId: string;
      method: string;
      payload: Record<string, unknown>;
    };
    calls.push({ method: body.method, payload: body.payload });
    const handler = handlers[body.method];
    const value = handler ? handler(body.payload) : {};
    return new Response(
      JSON.stringify({
        type: "server-response",
        rpcId: body.rpcId,
        result: { ok: true, value },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return {
    runtime: new DshRuntime({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl,
      ...(mcpConfigHost ? { mcpConfigHost } : {}),
    }),
    calls,
  };
}

describe("dsh 0.1.1 RPC contract", () => {
  it("reports the adapter/profile capabilities instead of unsupported method stubs", () => {
    const { runtime } = runtimeWith({});

    expect(runtime.getCapabilities()).toMatchObject({
      sessionFork: true,
      sessionArchive: true,
      sessionRestore: false,
      sessionDelete: false,
      sessionMove: false,
      sessionMessageRevert: false,
      syntheticMessageParts: false,
      skills: true,
      interactivePermissions: true,
      modelSelection: true,
      credentials: true,
      goals: true,
      dynamicMcpConfiguration: false,
      dynamicProviderConfiguration: false,
      oauthAuthentication: false,
    });
    expect(Object.isFrozen(runtime.getCapabilities())).toBe(true);
  });

  it("enables dynamic MCP only with a desktop host and never passes secret values to it", async () => {
    const host = {
      list: vi.fn(async () => []),
      upsert: vi.fn(async () => []),
      remove: vi.fn(async () => ["FRED_API_KEY"]),
    };
    const { runtime, calls } = runtimeWith({ "credentials.set": () => ({}) }, host);

    expect(runtime.getCapabilities().dynamicMcpConfiguration).toBe(true);
    await runtime.addMcpServer("fred", {
      type: "local",
      command: ["python", "-m", "fred_mcp"],
      environment: { FRED_API_KEY: "secret-value" },
      enabled: true,
    });

    expect(calls).toContainEqual({
      method: "credentials.set",
      payload: { ref: "FRED_API_KEY", value: "secret-value" },
    });
    expect(host.upsert).toHaveBeenCalledWith(
      "fred",
      { type: "local", command: ["python", "-m", "fred_mcp"], enabled: true },
      ["FRED_API_KEY"],
    );
    expect(JSON.stringify(host.upsert.mock.calls)).not.toContain("secret-value");
  });

  it("removes orphaned MCP credentials after the host removes a server", async () => {
    const host = {
      list: vi.fn(async () => []),
      upsert: vi.fn(async () => []),
      remove: vi.fn(async () => ["FRED_API_KEY"]),
    };
    const { runtime, calls } = runtimeWith({ "credentials.unset": () => ({}) }, host);

    await runtime.removeMcpServer("fred");

    expect(host.remove).toHaveBeenCalledWith("fred");
    expect(calls).toContainEqual({
      method: "credentials.unset",
      payload: { ref: "FRED_API_KEY" },
    });
  });

  it("carries the latest goal ref through CAS mutations", async () => {
    const { runtime, calls } = runtimeWith({
      "goal.create": () => ({ ref: { id: "goal-1", revision: 1 } }),
      "goal.pause": () => ({ ref: { id: "goal-1", revision: 2 } }),
      "goal.resume": () => ({ ref: { id: "goal-1", revision: 3 } }),
      "goal.complete": () => ({ ref: { id: "goal-1", revision: 4 } }),
    });

    await runtime.createGoal("session-1", "finish the experiment");
    await runtime.pauseGoal("session-1");
    await runtime.resumeGoal("session-1");
    await runtime.completeGoal("session-1");

    expect(calls).toEqual([
      {
        method: "goal.create",
        payload: { sessionId: "session-1", objective: "finish the experiment" },
      },
      {
        method: "goal.pause",
        payload: { sessionId: "session-1", ref: { id: "goal-1", revision: 1 } },
      },
      {
        method: "goal.resume",
        payload: { sessionId: "session-1", ref: { id: "goal-1", revision: 2 } },
      },
      {
        method: "goal.complete",
        payload: { sessionId: "session-1", ref: { id: "goal-1", revision: 3 } },
      },
    ]);
  });

  it("recovers a goal ref from the durable history projection after restart", async () => {
    const { runtime, calls } = runtimeWith({
      "session.history": () => ({
        events: [],
        hasMore: false,
        projections: {
          asOfSeq: 12,
          values: {
            goal: {
              goal: {
                id: "goal-restored",
                revision: 7,
                objective: "restore",
                phase: "paused",
                maxGoalRounds: 10,
              },
              roundsStarted: 2,
              createdAt: 1,
              updatedAt: 2,
            },
          },
        },
      }),
      "goal.resume": () => ({ ref: { id: "goal-restored", revision: 8 } }),
    });

    await runtime.resumeGoal("session-restored");

    expect(calls).toEqual([
      {
        method: "session.history",
        payload: { sessionId: "session-restored", maxMessages: 1 },
      },
      {
        method: "goal.resume",
        payload: {
          sessionId: "session-restored",
          ref: { id: "goal-restored", revision: 7 },
        },
      },
    ]);
  });

  it("uses group.id and session.models.current for the model directory", async () => {
    const { runtime, calls } = runtimeWith({
      "llm.models": () => ({
        groups: [
          {
            id: "lab-local",
            name: "Lab Local",
            models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
          },
        ],
        failures: [],
      }),
      "workspace.list": () => ({ items: [], archivedSessionIds: [] }),
      "session.list": () => ({
        items: [
          {
            sessionId: "session-1",
            updatedAt: 1,
            running: false,
            blank: true,
          },
        ],
      }),
      "session.models": () => ({
        current: { provider: "lab-local", model: "deepseek-v4-flash" },
        routable: true,
        groups: [],
        failures: [],
      }),
      "session.selectModel": (payload) => ({
        selected: { provider: payload.provider, model: payload.model },
      }),
    });

    await expect(runtime.listProviders()).resolves.toEqual([
      {
        id: "lab-local",
        name: "Lab Local",
        models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
      },
    ]);
    await expect(runtime.getDefaultModel()).resolves.toBe("lab-local/deepseek-v4-flash");
    await runtime.setDefaultModel("lab-local/deepseek-v4-flash");

    expect(calls).toContainEqual({
      method: "session.models",
      payload: { sessionId: "session-1" },
    });
    expect(calls).toContainEqual({
      method: "session.selectModel",
      payload: {
        sessionId: "session-1",
        provider: "lab-local",
        model: "deepseek-v4-flash",
      },
    });
  });
});
