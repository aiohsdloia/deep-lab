import { memo } from "react";
import {
  Box,
  FileBarChart,
  FileCode2,
  FileText,
  Image as ImageIcon,
  LocateFixed,
  NotebookPen,
  Paperclip,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactBlock, ArtifactKind } from "@deeplab/shared";
import { cn } from "@/lib/cn";

const ICON: Record<ArtifactKind, React.ReactNode> = {
  figure: <ImageIcon size={15} />,
  script: <FileCode2 size={15} />,
  report: <FileText size={15} />,
  table: <FileBarChart size={15} />,
  notebook: <NotebookPen size={15} />,
  model: <Box size={15} />,
  data: <Paperclip size={15} />,
};

/** A file the agent produced, surfaced live in the thread and openable in the
 *  inspector. Clicking the card opens it; the "定位" action reveals it in the
 *  session's file browser (the old "打开" button was dropped — redundant with
 *  the whole card being clickable). */
export const ArtifactCard = memo(function ArtifactCard({
  block,
  onOpen,
  onLocate,
}: {
  block: ArtifactBlock;
  onOpen?: (a: ArtifactBlock) => void;
  /** "定位": reveal the file in the session's file browser. */
  onLocate?: (a: ArtifactBlock) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-input border border-border bg-surface px-3 py-2.5 text-sm",
        onOpen && "cursor-pointer hover:bg-surface-2",
      )}
      onClick={onOpen ? () => onOpen(block) : undefined}
      role={onOpen ? "button" : undefined}
    >
      <span className="shrink-0 text-accent">{ICON[block.artifact]}</span>
      <span className="truncate font-medium text-text">{block.filename}</span>
      <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted ring-1 ring-border">
        {t(`artifact.kind.${block.artifact}`)}
      </span>
      <span className="shrink-0 truncate text-xs text-muted">
        {t("artifact.via", { tool: block.tool })}
      </span>
      <div className="flex-1" />
      {onLocate && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onLocate(block);
          }}
          className="flex shrink-0 items-center gap-1 rounded-input px-2 py-1 text-xs text-link transition-colors hover:bg-surface-2"
          title={t("artifact.locateTitle")}
          aria-label={t("artifact.locateTitle")}
        >
          <LocateFixed size={13} /> {t("artifact.locate")}
        </button>
      )}
    </div>
  );
});
