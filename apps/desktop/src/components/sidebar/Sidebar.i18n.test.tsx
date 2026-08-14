import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/lib/store";
import { renderAt } from "@/test/render";

// COPYCAT RULE: useUiStore is module-global; reset the locale after each test
// so this suite never bleeds a non-English locale into other test files.
afterEach(() => useUiStore.getState().setLocale("en"));

describe("Sidebar i18n", () => {
  it("renders migrated nav labels and section heading in English", async () => {
    renderAt("/files");

    const nav = await screen.findByRole("navigation");
    // The secondary rows (Files etc.) are folded by default — expand them.
    await userEvent.click(
      screen.getByRole("button", { name: "Show notebooks, files, runs and skills" }),
    );
    expect(within(nav).getByText("Files")).toBeInTheDocument();
    expect(screen.getByText("Sessions")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});
