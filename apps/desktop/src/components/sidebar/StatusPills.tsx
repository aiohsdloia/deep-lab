import { useTranslation } from "react-i18next";
import type { RuntimeStatus } from "@deeplab/shared";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";

const RUNTIME_TONE: Record<RuntimeStatus, string> = {
  ready: "bg-ok",
  connecting: "bg-warn",
  error: "bg-error",
  offline: "bg-muted",
};

/** The runtime status row: the label ("运行时") with a status "light" to its
 *  right — green / amber / red / gray says whether the sidecar is up, judged
 *  from the dot alone. The slightly larger ringed dot reads as infrastructure
 *  rather than a session's small green dot; hover shows the exact status. */
export function StatusPills() {
  const { t } = useTranslation("nav");
  const runtime = useRuntimeStore((s) => s.status);

  return (
    <div className="flex shrink-0 items-center gap-3 pr-1 text-xs text-muted">
      <span
        className="flex items-center gap-1.5"
        title={`${t("status.runtime")}: ${t(`status.values.${runtime}`)}`}
        aria-label={`${t("status.runtime")}: ${t(`status.values.${runtime}`)}`}
      >
        <span>{t("status.runtime")}</span>
        <span className={cn("h-2 w-2 rounded-full ring-2 ring-border", RUNTIME_TONE[runtime])} />
      </span>
    </div>
  );
}
