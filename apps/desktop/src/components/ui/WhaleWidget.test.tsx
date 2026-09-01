import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { adaptWhaleWidgetScript } from "@/lib/tauri";
import { WhaleWidget } from "./WhaleWidget";

const whale = vi.hoisted(() => ({
  status: vi.fn(),
  script: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...original,
    getWhaleWidgetStatus: whale.status,
    getWhaleWidgetScript: whale.script,
  };
});

describe("WhaleWidget", () => {
  const previous = useRuntimeStore.getState();

  beforeEach(() => {
    useRuntimeStore.setState({ status: "ready", serverUrl: "http://127.0.0.1:4098" });
    whale.status.mockResolvedValue({
      enabled: true,
      pluginVersion: "0.2.10",
      upstreamCommit: "4448c61",
    });
    whale.script.mockResolvedValue(
      "window.__dshWhaleWidget=true;document.body.dataset.whale='upstream';",
    );
  });

  afterEach(() => {
    document.getElementById("deeplab-upstream-whale-widget")?.remove();
    delete document.body.dataset.whale;
    useRuntimeStore.setState(previous, true);
    vi.clearAllMocks();
  });

  it("mounts the complete upstream client instead of rendering a replacement panel", async () => {
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WhaleWidget />);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(document.getElementById("deeplab-upstream-whale-widget")).not.toBeNull();
    });
    expect(whale.script).toHaveBeenCalledWith("http://127.0.0.1:4098");
    expect(document.body.textContent).not.toContain("Used today");
    view!.unmount();
  });

  it("rewrites only the plugin endpoint prefix for the protected gateway", () => {
    const source = "window.__dshWhaleWidget=true;fetch('/dsh-whale/balance.json')";
    expect(adaptWhaleWidgetScript(source, "http://127.0.0.1:4098/runtime/token")).toContain(
      "fetch('http://127.0.0.1:4098/runtime/token/balance.json')",
    );
  });
});
