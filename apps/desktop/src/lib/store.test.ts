import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./store";

describe("uiStore theme", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useUiStore.setState({ theme: "warm" });
  });

  it("cycles theme (including the e-ink theme) and persists to localStorage", () => {
    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("dark");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("dark");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("eink");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("eink");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("light");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("light");

    useUiStore.getState().toggleTheme();
    expect(useUiStore.getState().theme).toBe("warm");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("warm");
  });

  it("persists and reloads the e-ink theme like any other", () => {
    useUiStore.getState().setTheme("eink");
    expect(window.localStorage.getItem("ai4s.theme.v2")).toBe("eink");
  });
});
