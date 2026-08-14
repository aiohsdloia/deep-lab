import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactBlock } from "@deeplab/shared";
import { ArtifactCard } from "./ArtifactCard";

const block: ArtifactBlock = {
  kind: "artifact",
  path: "output/figure.png",
  filename: "figure.png",
  artifact: "figure",
  tool: "write",
};

describe("ArtifactCard", () => {
  it("locate fires onLocate without opening; the card body opens", () => {
    const onOpen = vi.fn();
    const onLocate = vi.fn();
    render(<ArtifactCard block={block} onOpen={onOpen} onLocate={onLocate} />);

    // The "定位" button must not bubble into the card's open handler.
    fireEvent.click(screen.getByLabelText("Locate in file browser"));
    expect(onLocate).toHaveBeenCalledWith(block);
    expect(onOpen).not.toHaveBeenCalled();

    // Clicking the card body still opens.
    fireEvent.click(screen.getByText("figure.png"));
    expect(onOpen).toHaveBeenCalledWith(block);
  });
});
