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
});
