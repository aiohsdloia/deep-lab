import { describe, expect, it } from "vitest";
import { DshRuntime } from "@deeplab/sdk";
import type { RuntimeEvent } from "@deeplab/sdk";

/**
 * dsh's host stream reports cross-client session lifecycle: session-added /
 * session-removed / session-status (plus the existing agent-error). The SDK
 * folds those into normalized events the app can apply without re-listing.
 */
describe("DshRuntime host stream folding", () => {
  function makeRuntime() {
    const rt = new DshRuntime({ baseUrl: "http://127.0.0.1:1" });
    const events: RuntimeEvent[] = [];
    rt.onEvent((e: RuntimeEvent) => events.push(e));
    const fold = (f: unknown) =>
      (rt as unknown as { foldHostFrame: (f: unknown) => void }).foldHostFrame(f);
    return { rt, events, fold };
  }

  it("emits session.added / removed / status and agent-error from host frames", () => {
    const { events, fold } = makeRuntime();
    fold({ type: "host/session-added", sessionId: "s1", blank: false, title: "New", cwd: "/w", updatedAt: 123 });
    fold({ type: "host/session-status", sessionId: "s1", running: true });
    fold({ type: "host/session-removed", sessionId: "s1" });
    fold({ type: "host/agent-error", sessionId: "s2", message: "boom" });

    const byType = new Map<string, RuntimeEvent[]>();
    for (const e of events) {
      const list = byType.get(e.type) ?? [];
      list.push(e);
      byType.set(e.type, list);
    }
    expect(byType.get("session.added")?.length).toBe(1);
    const added = byType.get("session.added")![0] as { sessionId: string; title: string; cwd: string };
    expect(added.sessionId).toBe("s1");
    expect(added.title).toBe("New");
    expect(added.cwd).toBe("/w");

    const status = byType.get("session.status")![0] as { sessionId: string; running: boolean };
    expect(status.sessionId).toBe("s1");
    expect(status.running).toBe(true);

    expect(byType.get("session.removed")?.length).toBe(1);

    const err = byType.get("error")![0] as { sessionId: string; message: string };
    expect(err.sessionId).toBe("s2");
    expect(err.message).toBe("boom");
  });

  it("ignores host frames without a session id", () => {
    const { events, fold } = makeRuntime();
    fold({ type: "host/session-added" });
    fold({ type: "host/session-status" });
    expect(events.length).toBe(0);
  });
});
