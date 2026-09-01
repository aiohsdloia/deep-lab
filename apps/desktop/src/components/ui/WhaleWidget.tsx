import { useEffect, useState } from "react";
import { useRuntimeStore } from "@/lib/runtime";
import {
  getWhaleWidgetStatus,
  logDebug,
  showWhaleWidgetWindow,
  WHALE_WIDGET_CHANGED_EVENT,
} from "@/lib/tauri";

/**
 * Keeps the native upstream widget window in sync with runtime readiness. The
 * widget never mounts into DeepLab's document.
 */
export function WhaleWidget() {
  const runtimeReady = useRuntimeStore((state) => state.status === "ready");
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let live = true;
    void getWhaleWidgetStatus()
      .then((status) => {
        if (live) setEnabled(status.enabled);
      })
      .catch(() => undefined);
    const changed = (event: Event) => {
      setEnabled((event as CustomEvent<boolean>).detail);
    };
    window.addEventListener(WHALE_WIDGET_CHANGED_EVENT, changed);
    return () => {
      live = false;
      window.removeEventListener(WHALE_WIDGET_CHANGED_EVENT, changed);
    };
  }, []);

  useEffect(() => {
    if (!enabled || !runtimeReady) return;
    void showWhaleWidgetWindow()
      .then(() => logDebug("[whale] standalone window opened"))
      .catch((error) => {
        console.error("[deeplab-whale] could not open the standalone widget", error);
        void logDebug(
          `[whale] standalone window failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }, [enabled, runtimeReady]);

  return null;
}
