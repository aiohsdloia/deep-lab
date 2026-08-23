import type { DshRpcCaller, GoalProjection, GoalRef } from "./rpc-contract";

/** Native dsh Goal mutations with revision/CAS handling. */
export class DshGoalAdapter {
  private readonly refs = new Map<string, GoalRef>();

  constructor(private readonly api: DshRpcCaller) {}

  observeProjection(sessionId: string, value: unknown): void {
    const projection = asGoalProjection(value);
    if (projection) {
      this.refs.set(sessionId, {
        id: projection.goal.id,
        revision: projection.goal.revision,
      });
    }
    else if (value === null) this.refs.delete(sessionId);
  }

  async create(sessionId: string, objective: string, maxGoalRounds?: number): Promise<void> {
    const result = await this.api.call("goal.create", {
      sessionId,
      objective,
      ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
    });
    this.refs.set(sessionId, result.ref);
  }

  async edit(
    sessionId: string,
    patch: { objective?: string; maxGoalRounds?: number },
  ): Promise<void> {
    const ref = await this.currentRef(sessionId);
    const result = await this.api.call("goal.edit", { sessionId, ref, ...patch });
    this.refs.set(sessionId, result.ref);
  }

  async pause(sessionId: string): Promise<void> {
    await this.mutate("goal.pause", sessionId);
  }

  async resume(sessionId: string): Promise<void> {
    await this.mutate("goal.resume", sessionId);
  }

  async complete(sessionId: string): Promise<void> {
    await this.mutate("goal.complete", sessionId);
  }

  async clear(sessionId: string): Promise<void> {
    const ref = await this.currentRef(sessionId);
    await this.api.call("goal.clear", { sessionId, ref });
    this.refs.delete(sessionId);
  }

  private async mutate(
    method: "goal.pause" | "goal.resume" | "goal.complete",
    sessionId: string,
  ): Promise<void> {
    const ref = await this.currentRef(sessionId);
    const result = await this.api.call(method, { sessionId, ref });
    this.refs.set(sessionId, result.ref);
  }

  private async currentRef(sessionId: string): Promise<GoalRef> {
    const cached = this.refs.get(sessionId);
    if (cached) return cached;

    const history = await this.api.call("session.history", { sessionId, maxMessages: 1 });
    this.observeProjection(sessionId, history.projections?.values.goal);
    const loaded = this.refs.get(sessionId);
    if (!loaded) throw new Error(`dsh session ${sessionId} has no current goal`);
    return loaded;
  }
}

function asGoalProjection(value: unknown): GoalProjection | undefined {
  if (!value || typeof value !== "object") return undefined;
  const goal = (value as { goal?: unknown }).goal;
  if (!goal || typeof goal !== "object") return undefined;
  const ref = goal as { id?: unknown; revision?: unknown };
  if (typeof ref.id !== "string" || typeof ref.revision !== "number") return undefined;
  return value as GoalProjection;
}
