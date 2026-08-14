import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

/** A close button for the secondary pages (notebooks / files / runs / skills /
 *  projects). These pages cover the live session, so this returns to /live —
 *  the session the user was working in before the page took over. */
export function ClosePageButton({ className }: { className?: string }) {
  const { t } = useTranslation("pages");
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate("/live")}
      aria-label={t("closePage")}
      title={t("closePage")}
      className={cn(
        "rounded p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-text",
        className,
      )}
    >
      <X size={18} strokeWidth={1.5} />
    </button>
  );
}
