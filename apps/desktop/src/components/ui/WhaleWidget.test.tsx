import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { WhaleWidget } from "./WhaleWidget";

const whale = vi.hoisted(() => ({
  status: vi.fn(),
  balance: vi.fn(),
  lastTurn: vi.fn(),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...original,
    getWhaleWidgetStatus: whale.status,
    getWhaleBalance: whale.balance,
    getWhaleLastTurn: whale.lastTurn,
  };
});

describe("WhaleWidget", () => {
  const previousStatus = useRuntimeStore.getState().status;

  beforeEach(() => {
    useRuntimeStore.setState({ status: "ready" });
    whale.status.mockResolvedValue({
      enabled: true,
      pluginVersion: "0.2.10",
      upstreamCommit: "4448c61",
    });
    whale.balance.mockResolvedValue({
      ok: true,
      totalBalance: 12.5,
      todayUsage: 0.25,
      currency: "CNY",
      usageMode: "ledger",
      isPeak: false,
    });
    whale.lastTurn.mockResolvedValue({
      ok: true,
      seq: 1,
      turn: 3,
      amount: 0.05,
      tokens: 1200,
      ts: Date.now(),
    });
  });

  afterEach(() => {
    useRuntimeStore.setState({ status: previousStatus });
    vi.clearAllMocks();
  });

  it("shows balance, today's usage, and the latest turn on demand", async () => {
    const view = render(<WhaleWidget />);
    const open = await screen.findByRole("button", { name: "Open DeepSeek balance and usage" });
    await userEvent.click(open);

    expect(await screen.findByText("Balance")).toBeInTheDocument();
    expect(screen.getByText("Used today")).toBeInTheDocument();
    expect(screen.getByText("Last turn")).toBeInTheDocument();
    expect(await screen.findByText("Off-peak")).toBeInTheDocument();
    await waitFor(() => {
      expect(whale.balance).toHaveBeenCalled();
      expect(whale.lastTurn).toHaveBeenCalled();
    });
    view.unmount();
  });
});
