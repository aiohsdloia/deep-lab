export interface UsageSample {
  inputTokens?: number;
  cacheReadTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface UsageTotals {
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export const EMPTY_TOTALS: UsageTotals = {
  inputTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/** Pull a token usage sample out of an assistant/usage event payload, tolerating
 *  dsh's field spellings. Returns undefined when the payload carries none. */
export function usageSampleFromPayload(payload: unknown): UsageSample | undefined {
  const d = (payload ?? {}) as Record<string, unknown>;
  const u = (d.usage ?? d) as Record<string, unknown>;
  const s: UsageSample = {};
  const inT = num(u.inputTokens) ?? num(u.promptTokens);
  if (inT !== undefined) s.inputTokens = inT;
  const cache = num(u.cacheReadTokens) ?? num(u.promptCacheHitTokens);
  if (cache !== undefined) s.cacheReadTokens = cache;
  const out = num(u.outputTokens) ?? num(u.completionTokens);
  if (out !== undefined) s.outputTokens = out;
  const reason = num(u.reasoningTokens);
  if (reason !== undefined) s.reasoningTokens = reason;
  if (s.inputTokens === undefined && s.cacheReadTokens === undefined && s.outputTokens === undefined && s.reasoningTokens === undefined) {
    return undefined;
  }
  return s;
}

export function accumulateUsage(acc: UsageTotals, sample: UsageSample): UsageTotals {
  return {
    inputTokens: acc.inputTokens + (sample.inputTokens ?? 0),
    cacheReadTokens: acc.cacheReadTokens + (sample.cacheReadTokens ?? 0),
    outputTokens: acc.outputTokens + (sample.outputTokens ?? 0),
    reasoningTokens: acc.reasoningTokens + (sample.reasoningTokens ?? 0),
  };
}

export function totalTokens(u: UsageTotals): number {
  return u.inputTokens + u.cacheReadTokens + u.outputTokens + u.reasoningTokens;
}

/** Compact per-session readout, e.g. "41,2k tok · ≈¥1.23". Local/lab/unknown
 *  providers show tokens only (their cost is not priced here). */
export function usageLabel(totals: UsageTotals, model: string | null | undefined): string | null {
  const n = totalTokens(totals);
  if (n <= 0) return null;
  const official = model != null && /deepseek/i.test(model);
  const cost = official
    ? estimateCostCny("deepseek-official", model, {
        inputTokens: totals.inputTokens,
        cacheReadTokens: totals.cacheReadTokens,
        outputTokens: totals.outputTokens,
        reasoningTokens: totals.reasoningTokens,
      })
    : 0;
  const num = n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  return cost && cost > 0 ? `${num} tok · ≈¥${cost.toFixed(2)}` : `${num} tok`;
}

/** Providers whose cost the app cannot price (local/lab/unknown) are honest
 *  zero/unknown rather than guessed. */
export function estimateCostCny(
  provider: string | null,
  _model: string | null,
  sample: UsageSample,
): number | null {
  const isOfficial =
    provider === "deepseek-official" ||
    provider === "deepseek" ||
    (provider ?? "").toLowerCase().includes("deepseek");
  if (!isOfficial) return 0;
  // DeepSeek CNY per million tokens: cache-hit input / cache-miss input / output.
  const PRICE = { hit: 0.5, miss: 1.5, out: 4.5 };
  const missInput = (sample.inputTokens ?? 0) - (sample.cacheReadTokens ?? 0);
  const cost =
    ((sample.cacheReadTokens ?? 0) / 1e6) * PRICE.hit +
    (Math.max(0, missInput) / 1e6) * PRICE.miss +
    (((sample.outputTokens ?? 0) + (sample.reasoningTokens ?? 0)) / 1e6) * PRICE.out;
  return cost;
}
