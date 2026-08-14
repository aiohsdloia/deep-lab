import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  LOCALES,
  resolveLocale,
  shippedLocales,
} from "./config";

describe("locale registry", () => {
  it("ships exactly the two supported locales, in order", () => {
    expect(shippedLocales().map((l) => l.code)).toEqual(["en", "zh-Hans"]);
  });

  it("marks both locales left-to-right", () => {
    for (const l of LOCALES) expect(l.dir).toBe("ltr");
  });

  it("has a native name for every locale", () => {
    for (const l of LOCALES) expect(l.nativeName.length).toBeGreaterThan(0);
  });
});

describe("resolveLocale", () => {
  it("returns an exact shipped match (case-insensitive)", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("EN")).toBe("en");
    expect(resolveLocale("zh-Hans")).toBe("zh-Hans");
    expect(resolveLocale("zh-hans")).toBe("zh-Hans");
  });

  it("falls back to a base-language match", () => {
    expect(resolveLocale("en-GB")).toBe("en");
    expect(resolveLocale("zh-CN")).toBe("zh-Hans");
  });

  it("never resolves to a removed language", () => {
    expect(resolveLocale("ja")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("fr-CA")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale("pt-BR")).toBe(DEFAULT_LOCALE);
  });

  it("falls back to the default for unknown or empty input", () => {
    expect(resolveLocale("xx")).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(null)).toBe(DEFAULT_LOCALE);
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE);
  });
});
