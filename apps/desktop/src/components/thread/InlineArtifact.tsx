import { memo } from "react";
import { LocateFixed } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactBlock } from "@deeplab/shared";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";

/** A real workspace preview placed at the exact point where the agent invoked
 *  `present_artifact`. It reuses the inspector renderers, so inline and panel
 *  modes never disagree about how a file type should look. */
export const InlineArtifact = memo(function InlineArtifact({
  block,
  workspaceDirectory,
  onLocate,
}: {
  block: ArtifactBlock;
  workspaceDirectory?: string;
  /** "定位": reveal the file in the session's file browser. */
  onLocate?: (a: ArtifactBlock) => void;
}) {
  const { t } = useTranslation(["session", "common"]);
  const inspector = fileInspectorFromBlock(block);
  if (inspector.variant === "notebook-file") return null;
  return (
    <div className="h-[min(460px,58vh)] min-h-72 w-full">
      <FilePreviewInspector
        data={inspector}
        workspaceDirectory={workspaceDirectory}
        embedded
        title={block.presentation?.title}
        controls={
          onLocate && (
            <button
              onClick={() => onLocate(block)}
              className="flex shrink-0 items-center gap-1 rounded-input px-2 py-1 text-xs text-link transition-colors hover:bg-surface-2"
              title={t("artifact.locateTitle")}
              aria-label={t("artifact.locateTitle")}
            >
              <LocateFixed size={13} /> {t("artifact.locate")}
            </button>
          )
        }
      />
    </div>
  );
});
