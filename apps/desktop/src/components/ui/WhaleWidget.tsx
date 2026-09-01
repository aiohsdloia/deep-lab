import { useEffect, useState } from "react";
import { useRuntimeStore } from "@/lib/runtime";
import {
  getWhaleWidgetScript,
  getWhaleWidgetStatus,
  logDebug,
  WHALE_WIDGET_CHANGED_EVENT,
} from "@/lib/tauri";

const SCRIPT_ID = "deeplab-upstream-whale-widget";

/**
 * Hosts the upstream dsh widget client in DeepLab's document. The client owns
 * its complete UI and behavior; this component only mounts it when enabled.
 */
export function WhaleWidget() {
  const runtimeReady = useRuntimeStore((state) => state.status === "ready");
  const serverUrl = useRuntimeStore((state) => state.serverUrl);
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
    if (!enabled || !runtimeReady || !serverUrl || document.getElementById(SCRIPT_ID)) return;
    let live = true;
    void getWhaleWidgetScript(serverUrl)
      .then((source) => {
        if (!live || document.getElementById(SCRIPT_ID)) return;
        const script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.textContent = source;
        document.body.appendChild(script);
        window.setTimeout(() => {
          const mounted = document.querySelector(".dshwv-root") !== null;
          void logDebug(`[whale] upstream client ${mounted ? "mounted" : "did not create its root"}`);
        }, 1_000);
      })
      .catch((error) => {
        console.error("[deeplab-whale] could not load the upstream widget", error);
        void logDebug(
          `[whale] upstream client load failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    return () => {
      live = false;
    };
  }, [enabled, runtimeReady, serverUrl]);

  return null;
}
