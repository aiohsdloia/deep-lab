import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { WhaleWidget } from "./WhaleWidget";

const whale = vi.hoisted(() => ({
  status: vi.fn(),
  show: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...original,
    getWhaleWidgetStatus: whale.status,
    showWhaleWidgetWindow: whale.show,
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
    whale.show.mockResolvedValue(undefined);
  });

  afterEach(() => {
    useRuntimeStore.setState(previous, true);
    vi.clearAllMocks();
  });

  it("opens the standalone native host instead of injecting into DeepLab", async () => {
    let view: ReturnType<typeof render>;
    await act(async () => {
      view = render(<WhaleWidget />);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(whale.show).toHaveBeenCalledOnce();
    });
    expect(document.querySelector(".dshwv-root")).toBeNull();
    expect(document.body.textContent).not.toContain("Used today");
    view!.unmount();
  });
});
