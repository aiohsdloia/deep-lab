import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderAt } from "@/test/render";
import { useUiStore } from "@/lib/store";
import { useRuntimeStore } from "@/lib/runtime";
import { shippedLocales } from "@/i18n/config";

describe("Settings language selector", () => {
  it("shows a Language select with one option per shipped locale", async () => {
    renderAt("/settings/appearance");
    const select = await screen.findByRole("combobox", { name: "Language" });
    expect(within(select).getAllByRole("option")).toHaveLength(shippedLocales().length);
  });

  it("updates the store locale on change", async () => {
    renderAt("/settings/appearance");
    const select = await screen.findByRole("combobox", { name: "Language" });
    await userEvent.selectOptions(select, "zh-Hans");
    expect(useUiStore.getState().locale).toBe("zh-Hans");
    useUiStore.getState().setLocale("en");
  });
});

describe("Settings page strings (i18n)", () => {
  it("renders the General section with the settings sidebar navigation", async () => {
    renderAt("/settings");
    expect(await screen.findByRole("heading", { level: 1, name: "General" })).toBeInTheDocument();
    expect(screen.getByText("Workspace")).toBeInTheDocument();
    expect(screen.getByText("available in the desktop app")).toBeInTheDocument();
    // The sidebar became the settings navigation with a way back to the app.
    expect(screen.getByRole("button", { name: "Back to app" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Connectors" })).not.toBeInTheDocument();
  });

  it("renders each section's own title and disconnected-runtime prompt", async () => {
    const connectors = renderAt("/settings/connectors");
    expect(await screen.findByText("MCP servers")).toBeInTheDocument();
    expect(screen.getByText("Connect the runtime to configure MCP servers.")).toBeInTheDocument();
    connectors.unmount();

    renderAt("/settings/models");
    expect(await screen.findByText("DeepSeek API key")).toBeInTheDocument();
  });

  it("shows the auto-review control on the general section", async () => {
    const view = renderAt("/settings");
    expect(
      await screen.findByRole("switch", { name: "Review after every turn that changes files" }),
    ).toBeInTheDocument();
    view.unmount();
  });

  it("renders the models returned by the dsh provider directory", async () => {
    const original = useRuntimeStore.getState();
    let view: ReturnType<typeof renderAt> | undefined;
    try {
      useRuntimeStore.setState({
        status: "ready",
        defaultModel: "lab-local/deepseek-v4-flash",
        providers: [
          {
            id: "lab-local",
            name: "Lab Local",
            models: [
              { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" },
              { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
            ],
          },
        ],
      });
      view = renderAt("/settings/models");
      expect(await screen.findByText("Lab Local")).toBeInTheDocument();
      expect(screen.getByText("DeepSeek V4 Flash")).toBeInTheDocument();
      expect(screen.getByText("DeepSeek V4 Pro")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /DeepSeek V4 Flash/ })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    } finally {
      view?.unmount();
      useRuntimeStore.setState({
        status: original.status,
        defaultModel: original.defaultModel,
        providers: original.providers,
      });
    }
  });
});
