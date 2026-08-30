import { describe, expect, it } from "vitest";
import { DSH_RUNTIME_CAPABILITIES, DshRuntime, NO_RUNTIME_CAPABILITIES } from "@deeplab/sdk";
import { visibleSections } from "./sections";

describe("settings capability filtering", () => {
  it("hides connector surfaces when no desktop Cordis host is available", () => {
    const keys = visibleSections(false, DSH_RUNTIME_CAPABILITIES).map((section) => section.key);

    expect(keys).not.toContain("connectors");
    expect(keys).not.toContain("browser");
    expect(keys).toContain("models");
  });

  it("shows connector surfaces for the desktop dsh composition", () => {
    const runtime = new DshRuntime({
      baseUrl: "http://127.0.0.1:1",
      mcpConfigHost: {
        list: async () => [],
        upsert: async () => [],
        remove: async () => [],
      },
    });
    const keys = visibleSections(false, runtime.getCapabilities()).map((section) => section.key);

    expect(keys).toContain("connectors");
    expect(keys).toContain("browser");
  });

  it("keeps runtime-independent desktop settings before connection", () => {
    const keys = visibleSections(false, NO_RUNTIME_CAPABILITIES).map((section) => section.key);

    expect(keys).toContain("general");
    expect(keys).toContain("appearance");
    expect(keys).toContain("compute");
  });

  it("still removes every native-only section in the gateway web client", () => {
    const keys = visibleSections(true, DSH_RUNTIME_CAPABILITIES).map((section) => section.key);

    expect(keys).toEqual(["general", "appearance", "models", "privacy"]);
  });
});
