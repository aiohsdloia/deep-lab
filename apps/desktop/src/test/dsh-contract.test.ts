import { describe, expect, it, vi } from "vitest";
import { DshRuntime } from "@deeplab/sdk";

type Handler = (payload: Record<string, unknown>) => unknown;

function runtimeWith(handlers: Record<string, Handler>) {
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
    runtime: new DshRuntime({ baseUrl: "http://127.0.0.1:1", fetchImpl }),
    calls,
  };
}

describe("dsh 0.1.1 RPC contract", () => {
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
