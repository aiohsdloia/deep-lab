import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { renderAt } from "@/test/render";

describe("CommandPalette", () => {
  beforeEach(() => useUiStore.setState({ paletteOpen: false }));

  it("opens on Cmd/Ctrl+K and filters actions", async () => {
    const user = userEvent.setup();
    renderAt("/skills");

    expect(screen.queryByPlaceholderText("Type a command…")).not.toBeInTheDocument();

    await user.keyboard("{Meta>}k{/Meta}");
    const input = await screen.findByPlaceholderText("Type a command…");
    expect(input).toBeInTheDocument();

    await user.type(input, "notebook");
    expect(screen.getByText("Open notebooks")).toBeInTheDocument();
    expect(screen.queryByText("Open settings")).not.toBeInTheDocument();
    // The removed analyze/audit starter actions are gone from the palette too.
    expect(screen.queryByText(/Audit a report/)).not.toBeInTheDocument();
  });
});
