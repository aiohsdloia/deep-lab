import { memo, useCallback, useEffect, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ArtifactBlock, FigureAnnotation, ThreadBlock } from "@deeplab/shared";
import { cn } from "@/lib/cn";
import { AgentMessage, DataTable, RunningJobsOverlay, StatusLine, UserMessage } from "./atoms";
import { ToolCallRow } from "./ToolCallRow";
import { ToolGroup, groupToolBlocks } from "./ToolGroup";
import { ReviewerCard } from "./ReviewerCard";
import { ReasoningRow } from "./ReasoningRow";
import { StepSummaryRow } from "./StepSummaryRow";
import { FigureBlock } from "./FigureBlock";
import { ArtifactCard } from "./ArtifactCard";
import { InlineArtifact } from "./InlineArtifact";
import { CompactionRow } from "./CompactionRow";

export interface BlockHandlers {
  /** Open an artifact in the inspector (live session). */
  onArtifactOpen?: (a: ArtifactBlock) => void;
  /** Locate an artifact in the file browser (live session). */
  onArtifactLocate?: (a: ArtifactBlock) => void;
  /** Forward a figure annotation to the agent (live session). */
  onFigureComment?: (annotation: FigureAnnotation, figureTitle: string) => void;
  /** Edit a past user message (revert + resend). Present only in the live
   *  session — its absence hides the per-message Edit button. */
  onEditMessage?: (messageID: string, newText: string) => void | Promise<void>;
  /** Revert to a past user message (drop it + everything after) and prefill the
   *  composer with its text. Present only in the live session. */
  onRevertMessage?: (messageID: string, text: string) => void | Promise<void>;
}

export function renderBlock(
  block: ThreadBlock,
  i: number,
  handlers?: BlockHandlers,
  liveReasoningIndex?: number,
  workspaceDirectory?: string,
) {
  switch (block.kind) {
    case "user":
      return (
        <UserMessage
          key={i}
          block={block}
          onEdit={handlers?.onEditMessage}
          onRevert={handlers?.onRevertMessage}
        />
      );
    case "agent":
      return <AgentMessage key={i} markdown={block.markdown} onOpenArtifact={handlers?.onArtifactOpen} />;
    case "reasoning":
      return <ReasoningRow key={i} block={block} streaming={i === liveReasoningIndex} />;
    case "step-summary":
      return <StepSummaryRow key={i} block={block} />;
    case "tool-call":
      return <ToolCallRow key={i} block={block} />;
    case "reviewer":
      return <ReviewerCard key={i} block={block} />;
    case "table":
      return <DataTable key={i} block={block} />;
    case "figure":
      return <FigureBlock key={i} block={block} onComment={handlers?.onFigureComment} />;
    case "artifact":
      return block.presentation?.mode === "inline" && !block.filename.endsWith(".ipynb") ? (
        <InlineArtifact
          key={i}
          block={block}
          workspaceDirectory={workspaceDirectory}
          onLocate={handlers?.onArtifactLocate}
        />
      ) : (
        <ArtifactCard key={i} block={block} onOpen={handlers?.onArtifactOpen} onLocate={handlers?.onArtifactLocate} />
      );
    case "running-jobs":
      return <RunningJobsOverlay key={i} block={block} />;
    case "compaction":
      return <CompactionRow key={i} block={block} />;
    case "status-line":
      return <StatusLine key={i} block={block} />;
  }
}

/** Gap between rows (matches the parent `gap-4` flex), folded into each row's
 *  own bottom padding so the absolutely-positioned virtual rows keep spacing. */
const ROW_GAP = 16;
/** Initial height estimate for a row before it is measured. */
const ROW_ESTIMATE = 200;

/**
 * Virtualized conversation list: only the visible window of blocks (plus a small
 *  overscan) is in the DOM, so a very long conversation keeps a constant DOM
 *  size, reconciliation cost and compositor layer tree regardless of length —
 *  the fix for whole-UI freezes on huge threads. Rows are measured as they
 *  render (variable-height blocks stay exact) and corrected for the thread's
 *  CSS page zoom.
 *
 * Memoized: with `blocks` unchanged (a re-render from unrelated state) the
 *  whole list — including groupToolBlocks — is skipped. When `blocks` does
 *  change, the per-block memo ensures only the touched rows re-render (#34).
 *  Requires callers to pass a stable `handlers` reference (see LiveSessionPage).
 */
export const BlockList = memo(function BlockList({
  blocks,
  handlers,
  liveReasoningIndex,
  workspaceDirectory,
  scrollElementRef,
  zoom = 1,
  scrollToBlockRef,
  highlightBlockIndex,
}: {
  blocks: ThreadBlock[];
  handlers?: BlockHandlers;
  /** Global index of the reasoning block streaming right now (live session);
   *  that block renders expanded and unfolds/collapses itself as it streams. */
  liveReasoningIndex?: number;
  /** Workspace directory that owns inline artifact files. */
  workspaceDirectory?: string;
  /** The thread's scroll container (the `overflow-y-auto` div); the virtual
   *  list measures visibility against it. */
  scrollElementRef: React.RefObject<HTMLElement | null>;
  /** CSS page zoom applied to the thread content, so measured row heights are
   *  corrected back to layout pixels. */
  zoom?: number;
  /** Filled with a `scrollToBlock(blockIndex)` handle the parent can call to
   *  jump the virtual list to a specific conversation block. */
  scrollToBlockRef?: React.MutableRefObject<((blockIndex: number) => void) | null>;
  /** A block index to flash (a brief accent highlight) — used after jumping to
   *  a question so the located message is easy to spot. Cleared by the parent. */
  highlightBlockIndex?: number;
}) {
  // Runs of quiet tool steps render as one collapsible group (Codex-style);
  // everything else — text, artifacts, prominent tool cards — on its own.
  const items = useMemo(() => groupToolBlocks(blocks), [blocks]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollElementRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: 8,
    // Sizes before the observer reports the real container (and in jsdom,
    // where no layout means offsetHeight is 0).
    initialRect: { width: 800, height: 600 },
    // Report the container's real viewport, falling back to a window when it
    // measures 0 (jsdom has no layout; a genuinely 0-height container renders
    // a window of rows until it has size).
    observeElementRect: (instance, cb) => {
      const el = instance.scrollElement as HTMLElement | null;
      const rect = () => {
        const w = el?.offsetWidth ?? 0;
        const h = el?.offsetHeight ?? 0;
        cb({ width: w || 800, height: h || 600 });
      };
      rect();
      if (!el || typeof ResizeObserver === "undefined") return () => {};
      const observer = new ResizeObserver(rect);
      observer.observe(el, { box: "border-box" });
      return () => observer.disconnect();
    },
    measureElement: (el) => el.getBoundingClientRect().height / zoom,
  });

  // Jump the list to a raw conversation-block index (maps it to its virtual
  // row — user/agent blocks are single rows, tool runs sit inside a group).
  const scrollToBlock = useCallback(
    (blockIndex: number) => {
      const idx = items.findIndex((item) =>
        item.kind === "group"
          ? blockIndex >= item.start && blockIndex < item.start + item.blocks.length
          : item.index === blockIndex,
      );
      if (idx >= 0) virtualizer.scrollToIndex(idx, { align: "start" });
    },
    [items, virtualizer],
  );
  useEffect(() => {
    if (scrollToBlockRef) scrollToBlockRef.current = scrollToBlock;
    return () => {
      if (scrollToBlockRef) scrollToBlockRef.current = null;
    };
  }, [scrollToBlock, scrollToBlockRef]);

  return (
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((vi) => {
        const item = items[vi.index];
        const key = item.kind === "group" ? `group:${item.start}` : item.index;
        const highlighted =
          highlightBlockIndex !== undefined &&
          (item.kind === "group"
            ? highlightBlockIndex >= item.start &&
              highlightBlockIndex < item.start + item.blocks.length
            : item.index === highlightBlockIndex);
        return (
          <div
            key={key}
            ref={virtualizer.measureElement}
            data-index={vi.index}
            className={cn("absolute left-0 right-0 top-0 rounded-card", highlighted && "block-highlight")}
            style={{ transform: `translateY(${vi.start}px)`, paddingBottom: ROW_GAP }}
          >
            {item.kind === "group" ? (
              <ToolGroup
                blocks={item.blocks}
                start={item.start}
                liveReasoningIndex={liveReasoningIndex}
              />
            ) : (
              renderBlock(item.block, item.index, handlers, liveReasoningIndex, workspaceDirectory)
            )}
          </div>
        );
      })}
    </div>
  );
});
