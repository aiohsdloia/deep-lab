import { describe, expect, it } from "vitest";
import { isInside } from "./Sidebar";

describe("isInside", () => {
  it("recognizes a folder inside the workspace, at any depth", () => {
    expect(isInside("/Users/a/Documents/OpenLab/仙侠克苏鲁", "/Users/a/Documents/OpenLab")).toBe(true);
    expect(isInside("/Users/a/Documents/OpenLab/projects/bci", "/Users/a/Documents/OpenLab")).toBe(true);
    expect(isInside("/Users/a/Documents/OpenLab", "/Users/a/Documents/OpenLab")).toBe(true);
  });

  it("compares whole segments — a shared prefix is not containment", () => {
    // The bug a naive startsWith would have: this folder is NOT in the workspace.
    expect(isInside("/Users/a/Documents/OpenLab-old/x", "/Users/a/Documents/OpenLab")).toBe(false);
    expect(isInside("/Users/a/Documents/Other", "/Users/a/Documents/OpenLab")).toBe(false);
  });

  it("ignores trailing slashes and doubled separators", () => {
    expect(isInside("/base/proj/", "/base/")).toBe(true);
    expect(isInside("/base//proj", "/base")).toBe(true);
  });

  it("handles Windows separators", () => {
    expect(isInside("C:\\Users\\a\\OpenLab\\proj", "C:\\Users\\a\\OpenLab")).toBe(true);
    expect(isInside("C:\\Users\\a\\Elsewhere", "C:\\Users\\a\\OpenLab")).toBe(false);
  });

  it("treats an empty base as containing nothing", () => {
    expect(isInside("/base/proj", "")).toBe(false);
  });
});
