import { describe, expect, it, vi } from "vitest";
import { DshRuntime } from "@deeplab/sdk";
import type { RuntimeEvent } from "@deeplab/sdk";

/**
 * dsh streams one reasoning/text block as MANY `assistant/chunk` deltas, each
 * with a monotonically increasing `seq` but the SAME block `index` within a
 * turn+step. The SDK must key the folded part by the block's stable identity
 * (turn·step·index), not by `seq` — otherwise every one-or-two-character delta
 * opens a NEW thread block and the conversation fills with empty "思考" rows.
 *
 * Regression guard for the partId fix: feed the exact chunk sequence dsh emits
 * for a single reasoning block and assert ONE stable partId is produced.
 */
describe("DshRuntime chunk folding partIds", () => {
  function foldEvent(event: { seq: number; type: string; turn: number; step: number; index: number; text?: string }) {
    const rt = new DshRuntime({ baseUrl: "http://127.0.0.1:1" });
    const seen: Array<{ type: string; partId: string; text: string }> = [];
    rt.onEvent((e: RuntimeEvent) => {
      if (e.type === "reasoning.updated" || e.type === "text.updated") {
        seen.push({ type: e.type, partId: e.partId, text: e.text });
      }
    });
    (rt as unknown as { foldSessionEvent: (sid: string, e: unknown) => void }).foldSessionEvent("s1", {
      type: "assistant/chunk",
      data: {
        turn: event.turn,
        step: event.step,
        chunk: { type: event.type, index: event.index, text: event.text ?? "" },
      },
    });
    return seen;
  }

  it("keys all reasoning deltas of one block to a single stable partId", () => {
    const all = [
      foldEvent({ seq: 1, type: "block-start", turn: 1, step: 1, index: 0 }),
      foldEvent({ seq: 2, type: "reasoning-delta", turn: 1, step: 1, index: 0, text: "The" }),
      foldEvent({ seq: 3, type: "reasoning-delta", turn: 1, step: 1, index: 0, text: " user" }),
      foldEvent({ seq: 4, type: "reasoning-delta", turn: 1, step: 1, index: 0, text: " asks" }),
      foldEvent({ seq: 5, type: "reasoning-delta", turn: 1, step: 1, index: 0, text: "…" }),
    ].flat();
    const reasoning = all.filter((e) => e.type === "reasoning.updated");
    expect(reasoning.length).toBe(4);
    // Every delta of the same block shares ONE partId, regardless of seq.
    const partIds = new Set(reasoning.map((e) => e.partId));
    expect(partIds.size).toBe(1);
  });

  it("does not collide reasoning partIds across different turns or blocks", () => {
    const r1 = foldEvent({ seq: 1, type: "reasoning-delta", turn: 1, step: 1, index: 0, text: "a" });
    const r2 = foldEvent({ seq: 2, type: "reasoning-delta", turn: 2, step: 1, index: 0, text: "b" });
    const t1 = foldEvent({ seq: 3, type: "text-delta", turn: 1, step: 1, index: 1, text: "c" });
    const ids = [r1[0]!.partId, r2[0]!.partId, t1[0]!.partId];
    expect(new Set(ids).size).toBe(3);
  });

  it("emits the accumulated full text, not the per-delta increment", () => {
    // One instantiation, three deltas of the same reasoning block — the SDK
    // must deliver the running total each time (the app folds full-text
    // idempotently), so the last event carries the whole reasoning.
    const rt = new DshRuntime({ baseUrl: "http://127.0.0.1:1" });
    const seen: Array<{ type: string; partId: string; text: string }> = [];
    rt.onEvent((e: RuntimeEvent) => {
      if (e.type === "reasoning.updated") seen.push({ type: e.type, partId: e.partId, text: e.text });
    });
    const fold = (text: string) =>
      (rt as unknown as { foldSessionEvent: (sid: string, e: unknown) => void }).foldSessionEvent("s1", {
        type: "assistant/chunk",
        data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text } },
      });
    fold("The");
    fold(" user");
    fold(" asks");
    expect(seen.map((e) => e.text)).toEqual(["The", "The user", "The user asks"]);
    // And one partId throughout.
    expect(new Set(seen.map((e) => e.partId)).size).toBe(1);
  });

  it("surfaces nested tool output from dsh's tool/result event", () => {
    const rt = new DshRuntime({ baseUrl: "http://127.0.0.1:1" });
    const seen: Array<{ callId: string; output?: string }> = [];
    rt.onEvent((e: RuntimeEvent) => {
      if (e.type === "tool.updated") seen.push({ callId: e.callId, output: e.output });
    });
    const fold = (e: unknown) =>
      (rt as unknown as { foldSessionEvent: (sid: string, e: unknown) => void }).foldSessionEvent("s1", e);
    fold({
      type: "tool/call",
      data: { callId: "call_1", name: "bash", arguments: '{"command":"echo hi"}' },
    });
    // dsh nests the result: callId lives on message.source.callId and the
    // tool-result block's toolCallId; the text is inside nested content.
    fold({
      type: "tool/result",
      data: {
        turn: 1,
        step: 1,
        message: {
          source: { kind: "tool", callId: "call_1" },
          content: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              content: [{ type: "text", text: "hi\n" }],
              isError: false,
            },
          ],
        },
      },
    });
    const result = seen.find((s) => s.output !== undefined);
    expect(result).toBeDefined();
    expect(result!.callId).toBe("call_1");
    expect(result!.output).toBe("hi\n");
  });
});

describe("DshRuntime approval folding", () => {
  function foldMux(runtime: DshRuntime, rpcId: string, frame: unknown) {
    (
      runtime as unknown as {
        foldMuxFrame: (requestId: string, value: unknown) => void;
      }
    ).foldMuxFrame(rpcId, frame);
  }

  it("correlates approvalId resolution broadcasts back to the request rpcId", async () => {
    const runtime = new DshRuntime({ baseUrl: "http://127.0.0.1:1" });
    const events: RuntimeEvent[] = [];
    runtime.onEvent((event) => events.push(event));

    foldMux(runtime, "rpc-request-1", {
      type: "approval/requested",
      sessionId: "session-1",
      approvalId: "approval-1",
      toolName: "bash",
      reason: "Run pnpm test",
    });

    await expect(runtime.listPermissions("session-1")).resolves.toMatchObject([
      {
        requestId: "rpc-request-1",
        action: "bash",
        resources: ["Run pnpm test"],
      },
    ]);

    foldMux(runtime, "rpc-broadcast-2", {
      type: "approval/resolved",
      sessionId: "session-1",
      approvalId: "approval-1",
      outcome: "allowed-once",
    });

    await expect(runtime.listPermissions("session-1")).resolves.toEqual([]);
    expect(events[events.length - 1]).toMatchObject({
      type: "permission.resolved",
      sessionId: "session-1",
      requestId: "rpc-request-1",
    });
  });

  it("sends the request rpcId and dsh approvalId when allowing once", async () => {
    const posted: unknown[] = [];
    const runtime = new DshRuntime({
      baseUrl: "http://127.0.0.1:1",
      fetchImpl: vi.fn(async (_input, init) => {
        posted.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    });
    foldMux(runtime, "rpc-request-1", {
      type: "approval/requested",
      sessionId: "session-1",
      approvalId: "approval-1",
      toolName: "bash",
    });

    await runtime.replyPermission("rpc-request-1", "once");

    expect(posted).toEqual([
      {
        type: "client-response",
        rpcId: "rpc-request-1",
        result: {
          ok: true,
          value: {
            sessionId: "session-1",
            approvalId: "approval-1",
            outcome: "allowed-once",
          },
        },
      },
    ]);
  });

  it("rejects persistent grants that dsh cannot represent", async () => {
    const runtime = new DshRuntime({ baseUrl: "http://127.0.0.1:1" });

    await expect(runtime.replyPermission("rpc-request-1", "always")).rejects.toMatchObject({
      name: "DshRpcError",
      code: "unsupported",
    });
  });
});
