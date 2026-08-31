import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { renderAt } from "@/test/render";
import { useRuntimeStore } from "@/lib/runtime";
import { useUiStore } from "@/lib/store";
import { SessionView } from "@/components/session/SessionView";
import { Composer } from "./Composer";
import { WorkflowStarters } from "./WorkflowStarters";

const realSendPrompt = useRuntimeStore.getState().sendPrompt;

// COPYCAT RULE: useUiStore is module-global; reset the locale after each test
// so this suite never bleeds a non-English locale into other test files.
afterEach(() => {
  useUiStore.getState().setLocale("en");
  useRuntimeStore.setState({
    status: "offline",
    catalogLoaded: false,
    defaultModel: null,
    currentId: null,
    threads: {},
    webReadOnly: false,
    sendPrompt: realSendPrompt,
  });
});

describe("Composer strings (i18n)", () => {
  it("renders the default placeholder and the approval-mode switch in English", () => {
    render(<Composer onSend={() => {}} approvalMode="approve" onApprovalModeChange={() => {}} />);
    expect(screen.getByPlaceholderText("Ask anything")).toBeInTheDocument();
    expect(screen.getByLabelText("Approval mode")).toHaveTextContent("Approve for me");
  });
});

describe("WorkflowStarters strings (i18n)", () => {
  it("renders the welcome copy and a starter card's title/description in English", () => {
    render(<WorkflowStarters onPick={() => {}} />);
    expect(screen.getByText("What should we look into?")).toBeInTheDocument();
    expect(screen.getByText("New browser action")).toBeInTheDocument();
    expect(
      screen.getByText("Ask the agent to open a browser and process data from web pages."),
    ).toBeInTheDocument();
  });
});

describe("LiveSessionPage strings (i18n)", () => {
  it("renders the disconnected-runtime card in English (no Tauri sidecar in tests)", async () => {
    renderAt("/live");
    expect(await screen.findByText("DeepSeek Harness runtime")).toBeInTheDocument();
    expect(
      screen.getByText((_, node) =>
        node?.textContent === "The desktop app runs a bundled DeepSeek Harness automatically. In the browser, start one with dsh web and connect.",
      ),
    ).toBeInTheDocument();
  });

  it("blocks a new turn and links to model settings after an empty catalog loads", () => {
    const sendPrompt = vi.fn();
    useRuntimeStore.setState({
      status: "ready",
      catalogLoaded: true,
      defaultModel: null,
      sendPrompt: sendPrompt as never,
    });
    render(
      <MemoryRouter>
        <SessionView sessionId={null} leafId="model-gate" focused />
      </MemoryRouter>,
    );

    expect(screen.getByText("Connect a model before starting")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Model settings" })).toBeInTheDocument();
    const input = screen.getByPlaceholderText("Connect a model to start");
    fireEvent.change(input, { target: { value: "start work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText("What should we look into?")).not.toBeInTheDocument();
  });
});
