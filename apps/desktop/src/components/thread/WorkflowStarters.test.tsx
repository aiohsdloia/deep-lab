import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_STARTERS, WorkflowStarters } from "./WorkflowStarters";

describe("WorkflowStarters", () => {
  it("renders one card per starter workflow", () => {
    render(<WorkflowStarters onPick={() => {}} />);
    // Titles are i18n-translated (session:starters.<id>.title); WORKFLOW_STARTERS
    // itself no longer carries display copy, only ids/prompts — assert the
    // rendered English text directly.
    expect(screen.getByText("Run the BCI trends demo")).toBeInTheDocument();
    expect(screen.getByText("Start a research pipeline")).toBeInTheDocument();
    expect(screen.getByText("Build a bioinformatics tool")).toBeInTheDocument();
    expect(screen.getByText("New browser action")).toBeInTheDocument();
    expect(screen.getByText("Build a phylogenetic tree")).toBeInTheDocument();
    expect(screen.getByText("Clean conversation")).toBeInTheDocument();
    expect(WORKFLOW_STARTERS).toHaveLength(6);
  });

  it("starts the dsh-native research pipeline through the bundled meta-skill", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);
    await userEvent.click(screen.getByText("Start a research pipeline"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toContain("ai4s-agent");
    expect(onPick.mock.calls[0][0]).toContain("DeepSeek Harness");
    expect(onPick.mock.calls[0][0]).toContain("subagents");
    expect(onPick.mock.calls[0][0]).toContain("Never invent citations or measured results");
    expect(onPick.mock.calls[0][1]).toMatchObject({ id: "research-pipeline" });
  });

  it("sends the BCI demo prompt and starter metadata on click", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);
    await userEvent.click(screen.getByText("Run the BCI trends demo"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toContain("bci-trends");
    expect(onPick.mock.calls[0][0]).toContain("python scripts/analyze.py");
    expect(onPick.mock.calls[0][0]).toContain("run `python verify.py`");
    expect(onPick.mock.calls[0][0]).toContain("present_artifact");
    expect(onPick.mock.calls[0][0]).not.toContain("Write plan.md");
    expect(onPick.mock.calls[0][0]).toContain("Do not access the network");
    expect(onPick.mock.calls[0][0]).toContain("create/edit anything under .deeplab");
    expect(onPick.mock.calls[0][1]).toMatchObject({ id: "bci-trends", example: "bci-trends" });
  });

  it("hides bundled examples when filesystem access is unavailable", () => {
    render(<WorkflowStarters onPick={() => {}} examplesEnabled={false} />);
    expect(screen.queryByText("Run the BCI trends demo")).not.toBeInTheDocument();
    expect(screen.getByText("Build a bioinformatics tool")).toBeInTheDocument();
  });

  it("sends the build-a-bioinformatics-tool prompt on click", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);
    await userEvent.click(screen.getByText("Build a bioinformatics tool"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toContain("生物信息学");
    expect(onPick.mock.calls[0][0]).toContain("工作区内的文献");
  });

  it("sends the browser prompt on click", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);
    await userEvent.click(screen.getByText("New browser action"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toContain("浏览器");
    expect(onPick.mock.calls[0][0]).toContain("待命");
  });

  it("sends the phylo prompt and asks the user to provide the sequence file", async () => {
    const onPick = vi.fn();
    render(<WorkflowStarters onPick={onPick} />);
    await userEvent.click(screen.getByText("Build a phylogenetic tree"));
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toContain("系统发育树");
    expect(onPick.mock.calls[0][0]).toContain("询问");
  });

  it("clean conversation opens a blank session: no prompt sent, onBlank fired", async () => {
    const onPick = vi.fn();
    const onBlank = vi.fn();
    render(<WorkflowStarters onPick={onPick} onBlank={onBlank} />);
    await userEvent.click(screen.getByText("Clean conversation"));
    expect(onBlank).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });
});
