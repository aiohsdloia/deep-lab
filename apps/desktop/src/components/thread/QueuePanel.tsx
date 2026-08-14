import { useEffect, useRef } from "react";
import { ListChecks, Plus, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QUEUE_DELAYS, QUEUE_REPEATS_MAX, useRuntimeStore } from "@/lib/runtime";
import type { QueueItem } from "@/lib/runtime";
import { cn } from "@/lib/cn";

/**
 * The per-session prompt-queue editor — a subpage opened from the composer's
 * "view queue" button. Every queued instruction shows as an editable textarea
 * plus its run plan (delay before it starts: immediately / 5 min / 10 min /
 * 30 min / 1 h) and its repeat count (default 1, max 99). Edits, adds and
 * removals write straight to the store, so the queue keeps draining live while
 * this is open (a prompt that auto-sends disappears here too). Esc closes it;
 * `role="dialog"` also keeps the pane's Esc-to-interrupt from firing while the
 * editor is up.
 */
/** Stable empty-queue fallback so the selector never hands out a fresh array
 *  per render (which would repaint the panel on every foreign store update). */
const EMPTY_QUEUE: QueueItem[] = [];
export function QueuePanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation(["session", "common"]);
  const items = useRuntimeStore((s) => s.queues[sessionId] ?? EMPTY_QUEUE);
  const updateQueueItem = useRuntimeStore((s) => s.updateQueueItem);
  const appendQueuedPrompt = useRuntimeStore((s) => s.appendQueuedPrompt);
  const removeQueuedPrompt = useRuntimeStore((s) => s.removeQueuedPrompt);
  const clearQueue = useRuntimeStore((s) => s.clearQueue);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("queue.title")}
      className="absolute inset-0 z-30 flex items-start justify-center overflow-y-auto bg-surface/70 px-4 py-10 backdrop-blur-sm"
    >
      <div className="w-full max-w-[680px] rounded-card border border-border bg-surface shadow-pop">
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <ListChecks size={15} className="text-accent" />
          <span className="text-sm font-medium text-text">{t("queue.title")}</span>
          <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] tabular-nums text-muted">
            {t("queue.count", { count: items.length })}
          </span>
          <div className="flex-1" />
          {items.length > 0 && (
            <button
              className="rounded px-2 py-1 text-xs text-muted transition-colors hover:bg-error/10 hover:text-error"
              onClick={() => clearQueue(sessionId)}
            >
              {t("queue.clear")}
            </button>
          )}
          <button
            className="rounded p-1 text-muted transition-colors hover:bg-surface-2 hover:text-text"
            aria-label={t("queue.closeAria")}
            title={t("queue.closeTitle")}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </header>

        <div className="max-h-[52vh] space-y-2 overflow-y-auto px-4 py-3">
          {items.length === 0 ? (
            <div className="py-10 text-center text-xs text-muted">{t("queue.empty")}</div>
          ) : (
            items.map((item, i) => (
              <QueueRow
                key={i}
                item={item}
                onChangeText={(v) => updateQueueItem(sessionId, i, { text: v })}
                onChangeDelay={(delayMin) => updateQueueItem(sessionId, i, { delayMin })}
                onChangeRepeats={(repeats) => updateQueueItem(sessionId, i, { repeats })}
                onRemove={() => removeQueuedPrompt(sessionId, i)}
              />
            ))
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-4 py-2.5">
          <p className="text-xs text-muted">{t("queue.hint")}</p>
          <button
            className="flex shrink-0 items-center gap-1 rounded-input border border-border px-2.5 py-1.5 text-xs text-text transition-colors hover:bg-surface-2"
            onClick={() => appendQueuedPrompt(sessionId, "")}
          >
            <Plus size={12} />
            {t("queue.add")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** One editable queue entry: the prompt text, its run plan (delay) and its
 *  repeat count, with a hover-to-reveal remove button. */
function QueueRow({
  item,
  onChangeText,
  onChangeDelay,
  onChangeRepeats,
  onRemove,
}: {
  item: QueueItem;
  onChangeText: (v: string) => void;
  onChangeDelay: (delayMin: number) => void;
  onChangeRepeats: (repeats: number) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation("session");
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow with the content.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [item.text]);
  return (
    <div className="rounded-input border border-border bg-surface-2">
      <div className="group relative">
        <textarea
          ref={ref}
          rows={2}
          value={item.text}
          onChange={(e) => onChangeText(e.target.value)}
          placeholder={t("queue.itemPlaceholder")}
          className={cn(
            "w-full resize-none rounded-input bg-transparent px-3 py-2 pr-8 text-[13px] leading-relaxed text-text outline-none transition-colors placeholder:text-muted focus:border-accent/60",
          )}
        />
        <button
          className="absolute right-1.5 top-1.5 rounded p-1 text-muted opacity-0 transition-opacity hover:bg-border hover:text-error group-hover:opacity-100"
          aria-label={t("queue.removeAria")}
          title={t("queue.removeTitle")}
          onClick={onRemove}
        >
          <Trash2 size={12} />
        </button>
      </div>
      {/* Run plan (delay before it starts) + repeat count. */}
      <div className="flex items-center gap-2 border-t border-border/70 px-3 py-1.5">
        <span className="text-[11px] text-muted">{t("queue.runPlan")}</span>
        <select
          value={item.delayMin}
          aria-label={t("queue.runPlanAria")}
          onChange={(e) => onChangeDelay(Number(e.target.value))}
          className="rounded-input border border-border bg-surface px-1.5 py-0.5 text-[11px] text-text outline-none focus:border-accent/60"
        >
          {QUEUE_DELAYS.map((d) => (
            <option key={d} value={d}>
              {t(`queue.delay.${d}`)}
            </option>
          ))}
        </select>
        <span className="ml-auto text-[11px] text-muted">{t("queue.repeats")}</span>
        <input
          type="number"
          min={1}
          max={QUEUE_REPEATS_MAX}
          value={item.repeats}
          aria-label={t("queue.repeatsAria")}
          title={t("queue.repeatsTitle", { max: QUEUE_REPEATS_MAX })}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n) && n >= 1) onChangeRepeats(n);
          }}
          className="w-14 rounded-input border border-border bg-surface px-1.5 py-0.5 text-[11px] tabular-nums text-text outline-none focus:border-accent/60"
        />
      </div>
    </div>
  );
}
