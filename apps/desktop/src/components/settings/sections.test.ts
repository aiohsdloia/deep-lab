import { describe, expect, it } from "vitest";
import { DSH_RUNTIME_CAPABILITIES, NO_RUNTIME_CAPABILITIES } from "@deeplab/sdk";
import { visibleSections } from "./sections";

describe("settings capability filtering", () => {
  it("hides dsh connector surfaces until Cordis configuration is implemented", () => {
    const keys = visibleSections(false, DSH_RUNTIME_CAPABILITIES).map((section) => section.key);

    expect(keys).not.toContain("connectors");
    expect(keys).not.toContain("browser");
    expect(keys).toContain("models");
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
