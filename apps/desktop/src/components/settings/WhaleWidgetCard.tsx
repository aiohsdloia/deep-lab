import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import {
  getWhaleWidgetConfig,
  getWhaleWidgetStatus,
  setWhaleWidgetEnabled,
  setWhaleWidgetUsageMode,
  WHALE_WIDGET_CHANGED_EVENT,
  type WhaleWidgetConfig,
} from "@/lib/tauri";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { inputCls } from "./inputCls";
import { Row, Section, Switch } from "./Section";

export const DEEPSEEK_PLATFORM_TOKEN_REF = "DEEPSEEK_PLATFORM_TOKEN";

export function WhaleWidgetCard() {
  const { t } = useTranslation(["settings", "common"]);
  const connected = useRuntimeStore((state) => state.status === "ready");
  const reconnect = useRuntimeStore((state) => state.connectRetry);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"ledger" | "token">("ledger");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void getWhaleWidgetStatus().then(async (status) => {
      if (!live) return;
      setEnabled(status.enabled);
      if (status.enabled && connected) {
        const config = await getWhaleWidgetConfig().catch((): WhaleWidgetConfig => ({}));
        if (live && config.usageMode) setMode(config.usageMode);
      }
    });
    return () => {
      live = false;
    };
  }, [connected]);

  const notifyChanged = (next: boolean) => {
    window.dispatchEvent(new CustomEvent(WHALE_WIDGET_CHANGED_EVENT, { detail: next }));
  };

  const toggle = async (next: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      await setWhaleWidgetEnabled(next);
      setEnabled(next);
      await reconnect();
      if (next) {
        const config = await getWhaleWidgetConfig().catch((): WhaleWidgetConfig => ({}));
        if (config.usageMode) setMode(config.usageMode);
      }
      notifyChanged(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const chooseLedger = async () => {
    if (!enabled || busy) return;
    setBusy(true);
    try {
      await setWhaleWidgetUsageMode("ledger");
      setMode("ledger");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const savePlatformToken = async () => {
    const client = getClient();
    if (!client || !token.trim() || busy) return;
    setBusy(true);
    try {
      await client.setCredential(DEEPSEEK_PLATFORM_TOKEN_REF, token.trim());
      await setWhaleWidgetUsageMode("token");
      setToken("");
      setMode("token");
      toast.success(t("whale.tokenSaved"));
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
      <div className="divide-y divide-faint">
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
        {enabled && (
          <Row title={t("whale.usageMode")} hint={t(`whale.${mode}Hint`)}>
            <div className="mt-2.5 inline-flex gap-0.5 rounded-input bg-surface-2 p-0.5">
              {/* eslint-disable-next-line i18next/no-literal-string -- persisted plugin mode keys */}
              {(["ledger", "token"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={mode === value}
                  onClick={() => {
                    if (value === "ledger") void chooseLedger();
                    else setMode("token");
                  }}
                  disabled={busy}
                  className={cn(
                    "rounded-[6px] px-3 py-1.5 text-xs transition-colors",
                    mode === value ? "bg-surface text-text shadow-sm" : "text-muted hover:text-text",
                  )}
                >
                  {t(`whale.${value}`)}
                </button>
              ))}
            </div>
            {mode === "token" && (
              <div className="mt-3 flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <KeyRound
                    size={13}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
                  />
                  <input
                    type="password"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && token.trim()) void savePlatformToken();
                    }}
                    placeholder={t("whale.tokenPlaceholder")}
                    autoComplete="off"
                    spellCheck={false}
                    className={inputCls("w-full pl-8 font-mono")}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void savePlatformToken()}
                  disabled={!connected || busy || !token.trim()}
                  className="h-9 shrink-0 rounded-input bg-accent px-3 text-[13px] font-medium text-accent-fg disabled:bg-accent/50"
                >
                  {t("whale.useToken")}
                </button>
              </div>
            )}
          </Row>
        )}
      </div>
    </Section>
  );
}
