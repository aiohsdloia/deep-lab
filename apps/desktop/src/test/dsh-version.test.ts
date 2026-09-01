import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { DSH_VERSION } from "@deeplab/sdk";

/**
 * The pinned runtime version lives in two places that must agree: the SDK
 * constant (which the app now DISPLAYS in Settings, so a user can tell the
 * bundled runtime from their own dsh install) and the script that installs
 * the sidecar bundle. A pin that disagrees with itself would be worse — the
 * app would confidently report a version it is not running.
 */
describe("pinned DeepSeek Harness version", () => {
  const root = resolve(process.cwd(), "../..");
  const read = (path: string) => readFileSync(resolve(root, path), "utf8");

  it("is a bare semver", () => {
    expect(DSH_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.]+)?$/);
  });

  it("matches the sidecar install script", () => {
    const script = read("scripts/dev/fetch-dsh.sh");
    expect(script).toContain(`DSH_VERSION="\${DSH_VERSION:-${DSH_VERSION}}"`);
  });

  it("matches the checked-in sidecar package manifest", () => {
    const manifest = JSON.parse(read("runtime/dsh/package.json")) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.["@deepseek-ai/dsh"]).toBe(DSH_VERSION);
  });

  it("pins the optional whale widget source and license", () => {
    const manifest = JSON.parse(read("runtime/dsh-plugins/whale-widget/package.json")) as {
      name?: string;
      version?: string;
      license?: string;
    };
    const upstream = read("runtime/dsh-plugins/whale-widget/UPSTREAM");
    expect(manifest).toMatchObject({
      name: "dsh-whale-widget",
      version: "0.2.10",
      license: "MIT",
    });
    expect(upstream).toContain("4448c61db7d180c4c307aa3fa734db7c8507658d");
    expect(read("runtime/dsh-plugins/whale-widget/LICENSE")).toContain("MIT License");
    expect(read("runtime/dsh-plugins/whale-widget/README.md")).toContain(
      "DSH 小鲸鱼余额挂件",
    );
    expect(read("runtime/dsh-plugins/whale-widget/whale-widget-prompt.md")).toContain(
      "小鲸鱼",
    );
  });
});
