import { useState } from "react";
import { LocateFixed, Maximize2, Minimize2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactBlock } from "@deeplab/shared";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { startPaneDrag } from "@/lib/dragPane";
import { useLayoutStore } from "@/lib/layout";
import { useRuntimeStore } from "@/lib/runtime";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";
import { InspectorShell } from "@/components/inspector/InspectorShell";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";

export function PresentedArtifactPane({
  artifact,
  leafId,
  sessionId,
  onClose,
}: {
  artifact: ArtifactBlock;
  leafId: string;
  sessionId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["inspector", "session"]);
  const [confirmClose, setConfirmClose] = useState(false);
  const toggleZoom = useLayoutStore((s) => s.toggleZoom);
  const zoomed = useLayoutStore((s) => s.zoomedLeafId === leafId);
  const workspaceDirectory = useRuntimeStore(
    (s) =>
      s.sessions.find((session) => session.id === sessionId)?.directory ??
      (s.currentId === sessionId ? s.workspace ?? undefined : undefined),
  );
  const inspector = fileInspectorFromBlock(artifact);
  const revealFile = useRuntimeStore((s) => s.revealFile);
  const controls = (
    <>
      {inspector.variant === "file" && (
        <button
          className="flex shrink-0 items-center gap-1 rounded-input px-2 py-1 text-xs text-link transition-colors hover:bg-surface-2"
          onClick={() => revealFile(sessionId, artifact.path)}
          aria-label={t("session:artifact.locateTitle")}
          title={t("session:artifact.locateTitle")}
        >
          <LocateFixed size={13} strokeWidth={1.5} /> {t("session:artifact.locate")}
        </button>
      )}
      <button
        className="text-text hover:opacity-60"
        onClick={() => toggleZoom(leafId)}
        aria-label={zoomed ? t("shell.restorePanel") : t("shell.maximizePanel")}
        title={zoomed ? t("shell.restorePanel") : t("shell.maximizePanel")}
      >
        {zoomed ? <Minimize2 size={14} strokeWidth={1.5} /> : <Maximize2 size={14} strokeWidth={1.5} />}
      </button>
    </>
  );

  const content =
    inspector.variant === "file" ? (
      <div className="h-full bg-surface">
        <FilePreviewInspector
          key={artifact.presentation?.requestId ?? artifact.path}
          data={inspector}
          workspaceDirectory={workspaceDirectory}
          title={artifact.presentation?.title}
          onClose={() => setConfirmClose(true)}
          controls={controls}
          compactHeader
          onTitlePointerDown={(event) =>
            // eslint-disable-next-line i18next/no-literal-string -- DragSource discriminant, not UI copy.
            startPaneDrag(event, { kind: "pane", leafId, sessionId }, artifact.presentation?.title ?? artifact.filename)
          }
        />
      </div>
    ) : (
      <InspectorShell
        inspector={inspector}
        workspaceDirectory={workspaceDirectory}
        onClose={() => setConfirmClose(true)}
        controls={controls}
        compactHeader
      />
    );

  return (
    <>
      {content}
      {confirmClose && (
        <ConfirmDialog
          title={t("session:group.confirmClose.title")}
          body={t("session:group.confirmClose.body")}
          confirmLabel={t("session:group.confirmClose.action")}
          onConfirm={() => {
            setConfirmClose(false);
            onClose();
          }}
          onCancel={() => setConfirmClose(false)}
        />
      )}
    </>
  );
}
