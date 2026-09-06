import { describe, expect, it } from "vitest";
import {
  accumulateUsage,
  addUsageToAggregate,
  aggregateLabel,
  EMPTY_TOTALS,
  estimateCostCny,
  loadAggregate,
  resetAggregate,
  totalTokens,
  usageLabel,
  usageSampleFromPayload,
} from "./usage";

function fakeStorage(): Storage & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => store.get(k) ?? null,
    key: (i: number) => [...store.keys()][i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, v),
  } as unknown as Storage & { store: Map<string, string> };
}

describe("usageSampleFromPayload", () => {
  it("parses dsh-style assistant usage numbers", () => {
    expect(
      usageSampleFromPayload({
        usage: {
          inputTokens: 100,
          cacheReadTokens: 40,
          outputTokens: 30,
          reasoningTokens: 10,
        },
      }),
    ).toEqual({ inputTokens: 100, cacheReadTokens: 40, outputTokens: 30, reasoningTokens: 10 });
  });

  it("returns undefined when the payload has no usage", () => {
    expect(usageSampleFromPayload({ message: { text: "hi" } })).toBeUndefined();
    expect(usageSampleFromPayload({ usage: { nope: 1 } })).toBeUndefined();
  });
});

describe("accumulateUsage / totalTokens", () => {
  it("accumulates repeated samples per session", () => {
    const a = accumulateUsage(EMPTY_TOTALS, { inputTokens: 10, outputTokens: 5 });
    const b = accumulateUsage(a, { inputTokens: 2, cacheReadTokens: 3, reasoningTokens: 1 });
    expect(b).toEqual({ inputTokens: 12, cacheReadTokens: 3, outputTokens: 5, reasoningTokens: 1 });
    expect(totalTokens(b)).toBe(21);
  });
});

describe("estimateCostCny", () => {
  it("prices official DeepSeek at CNY and ignores local/lab providers", () => {
    const sample = { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 1_000_000 };
    const official = estimateCostCny("deepseek-official", "deepseek-v4-flash", sample);
    expect(official).toBeCloseTo(0.5 + 4.5, 6);
    expect(estimateCostCny("lab-local", "deepseek-v4-flash", sample)).toBe(0);
    expect(estimateCostCny(null, null, sample)).toBe(0);
  });
});

describe("usageLabel", () => {
  it("renders tokens plus CNY only for official DeepSeek", () => {
    const totals = { inputTokens: 50_000, cacheReadTokens: 10_000, outputTokens: 2_000, reasoningTokens: 500 };
    expect(usageLabel(totals, "deepseek-v4-flash") ?? "").toMatch(/tok · ≈¥/);
    expect(usageLabel(totals, "lab-server") ?? "").toMatch(/tok$/);
    expect(usageLabel(totals, null) ?? "").toMatch(/tok$/);
    expect(usageLabel(EMPTY_TOTALS, "deepseek-v4-flash")).toBeNull();
  });
});

describe("durable usage aggregate", () => {
  it("accumulates across samples and survives a reload (fake storage)", () => {
    const storage = fakeStorage();
    expect(loadAggregate(storage).costCny).toBe(0);
    addUsageToAggregate(storage, "deepseek-v4-flash", {
      inputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const reloaded = loadAggregate(storage);
    expect(totalTokens(reloaded.totals)).toBe(3_000_000);
    expect(reloaded.costCny).toBeCloseTo(5, 6);
    expect(aggregateLabel(reloaded)).toMatch(/3\.00M tok · ≈¥5\.00/);
    addUsageToAggregate(storage, "lab-model", { outputTokens: 500 });
    expect(totalTokens(loadAggregate(storage).totals)).toBe(3_000_500);
    resetAggregate(storage);
    expect(loadAggregate(storage).totals.outputTokens).toBe(0);
  });
});
