import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArtifactBlock } from "@deeplab/shared";

vi.mock("@/components/inspector/FilePreviewInspector", () => ({
  FilePreviewInspector: ({ controls }: { controls?: React.ReactNode }) => (
    <div data-testid="preview">{controls}</div>
  ),
}));

import { InlineArtifact } from "./InlineArtifact";

const block: ArtifactBlock = {
  kind: "artifact",
  path: "output/report.docx",
  filename: "report.docx",
  artifact: "report",
  tool: "write",
  presentation: { mode: "inline", title: "Revised report" },
};

describe("InlineArtifact", () => {
  it("renders a locate button that fires onLocate with the block", () => {
    const onLocate = vi.fn();
    render(<InlineArtifact block={block} onLocate={onLocate} />);
    fireEvent.click(screen.getByLabelText("Locate in file browser"));
    expect(onLocate).toHaveBeenCalledWith(block);
  });

  it("omits the locate button when no onLocate is provided (static context)", () => {
    render(<InlineArtifact block={block} />);
    expect(screen.queryByLabelText("Locate in file browser")).toBeNull();
  });
});
