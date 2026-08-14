import { describe, expect, it } from "vitest";
import { isInside } from "./Sidebar";

describe("isInside", () => {
  it("recognizes a folder inside the workspace, at any depth", () => {
    expect(isInside("/Users/a/Documents/DeepLab/仙侠克苏鲁", "/Users/a/Documents/DeepLab")).toBe(true);
    expect(isInside("/Users/a/Documents/DeepLab/projects/bci", "/Users/a/Documents/DeepLab")).toBe(true);
    expect(isInside("/Users/a/Documents/DeepLab", "/Users/a/Documents/DeepLab")).toBe(true);
  });

  it("compares whole segments — a shared prefix is not containment", () => {
    // The bug a naive startsWith would have: this folder is NOT in the workspace.
    expect(isInside("/Users/a/Documents/DeepLab-old/x", "/Users/a/Documents/DeepLab")).toBe(false);
    expect(isInside("/Users/a/Documents/Other", "/Users/a/Documents/DeepLab")).toBe(false);
  });

  it("ignores trailing slashes and doubled separators", () => {
    expect(isInside("/base/proj/", "/base/")).toBe(true);
    expect(isInside("/base//proj", "/base")).toBe(true);
  });

  it("handles Windows separators", () => {
    expect(isInside("C:\\Users\\a\\DeepLab\\proj", "C:\\Users\\a\\DeepLab")).toBe(true);
    expect(isInside("C:\\Users\\a\\Elsewhere", "C:\\Users\\a\\DeepLab")).toBe(false);
  });

  it("treats an empty base as containing nothing", () => {
    expect(isInside("/base/proj", "")).toBe(false);
  });
});
