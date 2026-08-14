import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRuntimeStore } from "@/lib/runtime";
import { loadAcpAgents, activeAcpAgentId } from "@/lib/acpAgents";
import { AcpAgentsCard } from "./AcpAgentsCard";

// The card only decides WHICH runtime to connect to; the connection itself is
// the store's job, so a reconnect is a spy here.
const connectRetry = vi.hoisted(() => vi.fn(async () => true));
const dshAcpLauncher = vi.hoisted(() => vi.fn(async (): Promise<string | null> => "/app/Resources/dsh-acp/launcher.mjs"));

vi.mock("@/lib/tauri", () => ({ isTauri: true, dshAcpLauncher }));
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn() } }));

beforeEach(() => {
  window.localStorage.clear();
  connectRetry.mockClear();
  dshAcpLauncher.mockClear();
  useRuntimeStore.setState({ connectRetry, status: "ready", runtimeKind: "dsh" });
});

describe("Settings → the agent this app drives", () => {
  it("adds a preset agent, selects it, and reconnects onto it", async () => {
    const user = userEvent.setup();
    render(<AcpAgentsCard />);

    // Nothing configured yet: the bundled runtime is the only choice, and it is
    // the selected one.
    expect(screen.getByRole("radio", { name: "OpenCode (bundled)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "Codex", command: "npx", args: ["-y", "@agentclientprotocol/codex-acp"] },
    ]);
    // Adding an agent does not START it — the user still has to pick it.
    expect(activeAcpAgentId()).toBeNull();
    expect(connectRetry).not.toHaveBeenCalled();

    await user.click(screen.getByRole("radio", { name: "Codex" }));
    await waitFor(() => expect(activeAcpAgentId()).toBe("acp-1"));
    // The runtime is chosen at connect time, so the choice is only real once the
    // app has reconnected onto it.
    expect(connectRetry).toHaveBeenCalled();
  });

  it("falls back to the bundled runtime when the running agent is removed", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Gemini CLI", command: "gemini", args: ["--acp"] }]),
    );
    window.localStorage.setItem("ai4s.acp.active.v1", "acp-1");
    render(<AcpAgentsCard />);

    expect(screen.getByRole("radio", { name: "Gemini CLI" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Remove" }));

    expect(loadAcpAgents()).toEqual([]);
    // Never left selecting an agent that is no longer configured.
    expect(activeAcpAgentId()).toBeNull();
    expect(connectRetry).toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "OpenCode (bundled)" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("saves an edited command and restarts the agent it is running", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Codex", command: "codex", args: [] }]),
    );
    window.localStorage.setItem("ai4s.acp.active.v1", "acp-1");
    render(<AcpAgentsCard />);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    const args = screen.getByLabelText("Arguments");
    await user.type(args, `--config "/Users/me/My Agents/acp.json"`);
    await user.click(screen.getByRole("button", { name: "Save" }));

    // The argument line is split the way a shell would, but never THROUGH a
    // shell — a path with spaces survives because it was quoted.
    expect(loadAcpAgents()).toEqual([
      {
        id: "acp-1",
        name: "Codex",
        command: "codex",
        args: ["--config", "/Users/me/My Agents/acp.json"],
      },
    ]);
    // The running child was started from the OLD command line — restart it, or
    // Settings describes one agent while another one answers.
    expect(connectRetry).toHaveBeenCalled();
  });

  it("adds the DeepSeek Harness preset pointing at the bundled launcher", async () => {
    const user = userEvent.setup();
    render(<AcpAgentsCard />);

    await user.click(screen.getByRole("button", { name: "DeepSeek Harness" }));
    await waitFor(() => expect(dshAcpLauncher).toHaveBeenCalled());
    // The preset must NOT save a bare npx invocation — the dsh demo needs its
    // cordis.yml and plugins beside it, which only the bundled runtime has.
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "DeepSeek Harness", command: "node", args: ["/app/Resources/dsh-acp/launcher.mjs"] },
    ]);
  });

  it("falls back to the npx form when the bundled runtime is absent", async () => {
    dshAcpLauncher.mockResolvedValueOnce(null);
    const user = userEvent.setup();
    render(<AcpAgentsCard />);

    await user.click(screen.getByRole("button", { name: "DeepSeek Harness" }));
    await waitFor(() => expect(dshAcpLauncher).toHaveBeenCalled());
    expect(loadAcpAgents()).toEqual([
      { id: "acp-1", name: "DeepSeek Harness", command: "npx", args: ["-y", "@deepseek-ai/dsh-acp-demo@next"] },
    ]);
  });

  it("shows a running ACP agent's failure as selectable copyable text", () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    window.localStorage.setItem(
      "ai4s.acp.agents.v1",
      JSON.stringify([{ id: "acp-1", name: "Codex", command: "codex", args: [] }]),
    );
    window.localStorage.setItem("ai4s.acp.active.v1", "acp-1");
    useRuntimeStore.setState({
      status: "error",
      runtimeKind: "acp",
      error: "config file not found: /ws/cordis.yml",
    });
    render(<AcpAgentsCard />);

    const err = screen.getByText("config file not found: /ws/cordis.yml");
    expect(err.className).toContain("select-text");
    fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
    expect(writeText).toHaveBeenCalledWith("config file not found: /ws/cordis.yml");
  });
});
