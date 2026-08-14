import { describe, expect, it } from "vitest";
import { DshRuntime } from "@deeplab/sdk";
import type { OpenCodeEvent } from "@deeplab/sdk";

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
    rt.onEvent((e: OpenCodeEvent) => {
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
    rt.onEvent((e: OpenCodeEvent) => {
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
});
