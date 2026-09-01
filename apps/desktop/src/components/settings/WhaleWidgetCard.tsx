import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getWhaleWidgetStatus,
  setWhaleWidgetEnabled,
  WHALE_WIDGET_CHANGED_EVENT,
} from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { Row, Section, Switch } from "./Section";

export function WhaleWidgetCard() {
  const { t } = useTranslation("settings");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void getWhaleWidgetStatus()
      .then((status) => {
        if (live) setEnabled(status.enabled);
      })
      .catch((error) => {
        if (live) toast.error(error instanceof Error ? error.message : String(error));
      });
    return () => {
      live = false;
    };
  }, []);

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await setWhaleWidgetEnabled(next);
      setEnabled(next);
      window.dispatchEvent(new CustomEvent(WHALE_WIDGET_CHANGED_EVENT, { detail: next }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title={t("whale.title")}
      hint={t("whale.hint")}
      action={
        <a
          href="https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget"
          className="flex items-center gap-1 text-xs text-muted hover:text-text"
        >
          {t("whale.upstream")} <ExternalLink size={12} />
        </a>
      }
      flush
    >
      <Row
        title={t("whale.enable")}
        hint={t("whale.enableHint")}
        control={
          <div className="flex items-center gap-2">
            {busy && <Loader2 size={13} className="animate-spin text-muted" />}
            <Switch
              checked={enabled ?? false}
              onChange={(next) => void toggle(next)}
              label={t("whale.enable")}
            />
          </div>
        }
      />
    </Section>
  );
}
