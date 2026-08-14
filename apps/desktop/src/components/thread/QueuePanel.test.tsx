import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useRuntimeStore } from "@/lib/runtime";
import type { QueueItem } from "@/lib/runtime";
import { QueuePanel } from "./QueuePanel";

const item = (text: string, over: Partial<QueueItem> = {}): QueueItem => ({
  text,
  delayMin: 0,
  repeats: 1,
  ...over,
});

describe("QueuePanel", () => {
  it("lists queued prompts and edits, adds and clears them through the store", () => {
    useRuntimeStore.setState({ queues: { ses_1: [item("first"), item("second")] } });
    render(<QueuePanel sessionId="ses_1" onClose={vi.fn()} />);

    const boxes = screen.getAllByRole("textbox");
    expect(boxes).toHaveLength(2);
    expect((boxes[0] as HTMLTextAreaElement).value).toBe("first");
    expect((boxes[1] as HTMLTextAreaElement).value).toBe("second");

    // Editing an item writes straight to the store.
    fireEvent.change(boxes[0]!, { target: { value: "first edited" } });
    expect(useRuntimeStore.getState().queues["ses_1"]!.map((x) => x.text)).toEqual([
      "first edited",
      "second",
    ]);

    // Add appends a blank row for the user to fill in.
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(useRuntimeStore.getState().queues["ses_1"]!.map((x) => x.text)).toEqual([
      "first edited",
      "second",
      "",
    ]);

    // Clear empties the queue.
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(useRuntimeStore.getState().queues["ses_1"]).toBeUndefined();
  });

  it("shows and edits each item's run plan and repeat count", () => {
    useRuntimeStore.setState({ queues: { ses_1: [item("first"), item("second", { delayMin: 30, repeats: 3 })] } });
    render(<QueuePanel sessionId="ses_1" onClose={vi.fn()} />);

    // Run-plan selects: row 1 defaults to "Now", row 2 shows its 30-minute plan.
    const plans = screen.getAllByRole("combobox");
    expect(plans).toHaveLength(2);
    expect((plans[0] as HTMLSelectElement).value).toBe("0");
    expect((plans[1] as HTMLSelectElement).value).toBe("30");

    // Repeat inputs: row 1 defaults to 1, row 2 to its repeat count.
    const repeats = screen.getAllByRole("spinbutton");
    expect(repeats).toHaveLength(2);
    expect((repeats[0] as HTMLInputElement).value).toBe("1");
    expect((repeats[1] as HTMLInputElement).value).toBe("3");

    // Changing the plan/repeats writes straight to the store.
    fireEvent.change(plans[0]!, { target: { value: "10" } });
    fireEvent.change(repeats[0]!, { target: { value: "5" } });
    expect(useRuntimeStore.getState().queues["ses_1"]![0].delayMin).toBe(10);
    expect(useRuntimeStore.getState().queues["ses_1"]![0].repeats).toBe(5);
  });

  it("removes a queued prompt and shows the empty state", () => {
    useRuntimeStore.setState({ queues: { ses_1: [item("a"), item("b")] } });
    render(<QueuePanel sessionId="ses_1" onClose={vi.fn()} />);

    fireEvent.click(screen.getAllByLabelText("Remove this queued prompt")[0]!);
    expect(useRuntimeStore.getState().queues["ses_1"]!.map((x) => x.text)).toEqual(["b"]);

    fireEvent.click(screen.getAllByLabelText("Remove this queued prompt")[0]!);
    expect(screen.getByText(/no queued prompts/i)).toBeInTheDocument();
  });

  it("closes on Esc", () => {
    useRuntimeStore.setState({ queues: { ses_1: [item("a")] } });
    const onClose = vi.fn();
    render(<QueuePanel sessionId="ses_1" onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
