import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import whaleImage from "@/assets/deepseek-whale.png";
import { useRuntimeStore } from "@/lib/runtime";
import {
  getWhaleBalance,
  getWhaleLastTurn,
  getWhaleWidgetStatus,
  WHALE_WIDGET_CHANGED_EVENT,
  type WhaleBalance,
  type WhaleLastTurn,
} from "@/lib/tauri";
import { cn } from "@/lib/cn";

const BALANCE_REFRESH_MS = 60_000;
const TURN_REFRESH_MS = 3_000;

export function WhaleWidget() {
  const { t, i18n } = useTranslation("settings");
  const runtimeReady = useRuntimeStore((state) => state.status === "ready");
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<WhaleBalance | null>(null);
  const [lastTurn, setLastTurn] = useState<WhaleLastTurn | null>(null);
  const seenTurn = useRef<number | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let live = true;
    void getWhaleWidgetStatus()
      .then((status) => {
        if (live) setEnabled(status.enabled);
      })
      .catch(() => undefined);
    const changed = (event: Event) => {
      const next = (event as CustomEvent<boolean>).detail;
      setEnabled(next);
      if (!next) setOpen(false);
    };
    window.addEventListener(WHALE_WIDGET_CHANGED_EVENT, changed);
    return () => {
      live = false;
      window.removeEventListener(WHALE_WIDGET_CHANGED_EVENT, changed);
    };
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!enabled || !runtimeReady) return;
    setLoading(true);
    try {
      setBalance(await getWhaleBalance());
    } catch (error) {
      setBalance({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }, [enabled, runtimeReady]);

  useEffect(() => {
    if (!enabled || !runtimeReady) return;
    void refreshBalance();
    const timer = window.setInterval(() => void refreshBalance(), BALANCE_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled, refreshBalance, runtimeReady]);

  useEffect(() => {
    if (!enabled || !runtimeReady) return;
    let live = true;
    const refreshTurn = async () => {
      try {
        const next = await getWhaleLastTurn();
        if (!live) return;
        setLastTurn(next);
        if (seenTurn.current != null && next.seq > seenTurn.current) {
          setOpen(true);
          if (closeTimer.current) clearTimeout(closeTimer.current);
          closeTimer.current = setTimeout(() => setOpen(false), 5_000);
        }
        seenTurn.current = next.seq;
      } catch {
        /* The plugin may still be starting after an enabled-state restart. */
      }
    };
    void refreshTurn();
    const timer = window.setInterval(() => void refreshTurn(), TURN_REFRESH_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [enabled, runtimeReady]);

  if (!enabled) return null;

  const formatMoney = (value: number | null | undefined, currency = "CNY") => {
    if (value == null || !Number.isFinite(value)) return "--";
    try {
      return new Intl.NumberFormat(i18n.language, {
        style: "currency",
        currency,
        minimumFractionDigits: value < 1 ? 3 : 2,
        maximumFractionDigits: value < 1 ? 3 : 2,
      }).format(value);
    } catch {
      return `${value.toFixed(2)} ${currency}`;
    }
  };

  return (
    <div className="pointer-events-none fixed bottom-2 right-2 z-[70] h-[116px] w-[116px] sm:bottom-3 sm:right-3 sm:h-[132px] sm:w-[132px]">
      {open && (
        <div className="pointer-events-auto absolute bottom-[86px] right-2 w-[220px] rounded-card border border-border bg-surface p-3 shadow-lg sm:bottom-[98px]">
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 text-xs font-medium text-text">{t("whale.summary")}</span>
            <button
              type="button"
              onClick={() => void refreshBalance()}
              aria-label={t("whale.refresh")}
              title={t("whale.refresh")}
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <RefreshCw size={13} className={cn(loading && "animate-spin")} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={t("whale.close")}
              className="rounded p-1 text-muted hover:bg-surface-2 hover:text-text"
            >
              <X size={13} />
            </button>
          </div>
          {balance?.ok ? (
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
              <dt className="text-muted">{t("whale.balance")}</dt>
              <dd className="font-medium tabular-nums text-text">
                {formatMoney(balance.totalBalance, balance.currency)}
              </dd>
              <dt className="text-muted">{t("whale.todayUsage")}</dt>
              <dd className="tabular-nums text-text">
                {formatMoney(balance.todayUsage, balance.currency)}
              </dd>
              <dt className="text-muted">{t("whale.lastTurn")}</dt>
              <dd className="tabular-nums text-text">
                {formatMoney(lastTurn?.amount, balance.currency)}
              </dd>
              <dt className="text-muted">{t("whale.pricing")}</dt>
              <dd className={balance.isPeak ? "text-warn" : "text-ok"}>
                {balance.isPeak ? t("whale.peak") : t("whale.offPeak")}
              </dd>
            </dl>
          ) : (
            <p className="mt-2 text-xs leading-relaxed text-muted">
              {balance?.code === "NO_KEY" ? t("whale.noKey") : balance?.error ?? t("whale.loading")}
            </p>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("whale.open")}
        title={t("whale.open")}
        className="pointer-events-auto absolute bottom-0 right-0 h-[96px] w-[96px] rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:h-[112px] sm:w-[112px]"
      >
        <img
          src={whaleImage}
          alt=""
          draggable={false}
          className="h-full w-full select-none object-contain drop-shadow-md"
        />
      </button>
    </div>
  );
}
