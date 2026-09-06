import { useRuntimeStore } from "@/lib/runtime";
import { usageLabel, totalTokens } from "@/lib/usage";

/** Compact live token/cost readout for a session, next to the model pill. */
export function UsagePill({ sessionId }: { sessionId?: string }) {
  const totals = useRuntimeStore((s) => (sessionId ? s.usageBySession[sessionId] : undefined));
  const model = useRuntimeStore((s) =>
    sessionId ? (s.sessionModels[sessionId] ?? s.defaultModel) : null,
  );
  if (!sessionId || !totals || totalTokens(totals) <= 0) return null;
  const label = usageLabel(totals, model);
  if (!label) return null;
  return <span className="whitespace-nowrap text-[11px] text-muted">{label}</span>;
}
