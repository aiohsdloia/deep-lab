import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  autoReviewPrompt,
  isMutatingTool,
  shouldAutoReview,
  type AutoReviewGate,
} from "./autoReview";

const ON: AutoReviewGate = {
  enabled: true,
  changedFiles: true,
  wasReview: false,
  isSubagent: false,
  hasReviewer: true,
};

describe("isMutatingTool", () => {
  it("counts a successful write or edit as a workspace change", () => {
    expect(isMutatingTool("write", "success")).toBe(true);
    expect(isMutatingTool("edit", "success")).toBe(true);
    expect(isMutatingTool("apply_patch", "success")).toBe(true);
  });

  it("ignores a tool that only read, and one that has not finished", () => {
    expect(isMutatingTool("read", "success")).toBe(false);
    expect(isMutatingTool("grep", "success")).toBe(false);
    expect(isMutatingTool("write", "running")).toBe(false);
    expect(isMutatingTool("write", "failed")).toBe(false);
  });

  it("ignores bash — a shell step that writes is indistinguishable from `ls`", () => {
    expect(isMutatingTool("bash", "success")).toBe(false);
  });
});

describe("shouldAutoReview", () => {
  it("reviews a finished turn that changed files", () => {
    expect(shouldAutoReview(ON)).toBe(true);
  });

  it("stays out of the way when the user has not opted in", () => {
    expect(shouldAutoReview({ ...ON, enabled: false })).toBe(false);
  });

  it("skips a turn with nothing to audit", () => {
    expect(shouldAutoReview({ ...ON, changedFiles: false })).toBe(false);
  });

  it("never reviews a review — that is the loop", () => {
    expect(shouldAutoReview({ ...ON, wasReview: true })).toBe(false);
  });

  it("leaves a subagent session to its parent's review", () => {
    expect(shouldAutoReview({ ...ON, isSubagent: true })).toBe(false);
  });

  it("does nothing when the runtime has no reviewer agent", () => {
    expect(shouldAutoReview({ ...ON, hasReviewer: false })).toBe(false);
  });
});

describe("autoReviewPrompt", () => {
  it("pins the reviewer to the completed turn's changed files", () => {
    const prompt = autoReviewPrompt(["analysis.py", "report.md"], "Fit the preregistered model");
    expect(prompt).toContain("- analysis.py\n- report.md");
    expect(prompt).toContain("Fit the preregistered model");
    expect(prompt).toContain("checkpoint only");
    expect(prompt).toContain("absent Git HEAD");
  });
});

describe("the reviewer preset", () => {
  it("uses the native dsh composition and enforces read-only execution", () => {
    const root = resolve(process.cwd(), "../../runtime/dsh-profile/presets/reviewer");
    const composition = readFileSync(resolve(root, "agent.cordis.yml"), "utf8");
    const policy = readFileSync(resolve(root, "reviewer-policy.mjs"), "utf8");

    expect(composition).toContain("name: '@deepseek-ai/dsh-tool-fs'");
    expect(composition).not.toContain("name: '@deepseek-ai/dsh-tool-bash'");
    expect(composition).not.toContain("name: '@deepseek-ai/dsh-tool-subagent'");
    expect(composition).toContain("name: './reviewer-policy.mjs'");
    expect(policy).toContain('"write"');
    expect(policy).toContain('"edit"');
    expect(policy).toContain("ctx.tools.guard");
  });

  it("denies mutation tools while allowing reads", async () => {
    const path = resolve(
      process.cwd(),
      "../../runtime/dsh-profile/presets/reviewer/reviewer-policy.mjs",
    );
    const policy = (await import(/* @vite-ignore */ pathToFileURL(path).href)) as {
      apply(ctx: {
        tools: {
          restrict(filter: { allow: string[] }): void;
          guard(callback: (execution: { name: string }) => string | undefined): void;
        };
      }): void;
    };
    let guard: ((execution: { name: string }) => string | undefined) | undefined;
    let restriction: { allow: string[] } | undefined;
    policy.apply({
      tools: {
        restrict(filter) {
          restriction = filter;
        },
        guard(callback) {
          guard = callback;
        },
      },
    });

    expect(restriction).toEqual({ allow: [] });
    expect(guard?.({ name: "write" })).toContain("read-only");
    expect(guard?.({ name: "edit" })).toContain("read-only");
    expect(guard?.({ name: "read" })).toBeUndefined();
  });
});
