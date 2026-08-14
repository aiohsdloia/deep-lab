import { afterEach, describe, expect, it } from "vitest";
import { detectInitialLocale, LOCALE_KEY } from "./config";

/** jsdom's real localStorage is Proxy-backed, so `vi.spyOn` on its methods
 *  does not reliably intercept calls — swap in a plain mock Storage instead. */
function mockStorage(saved: string | null) {
  const original = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => (key === LOCALE_KEY ? saved : null),
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    },
    configurable: true,
  });
  return () => Object.defineProperty(window, "localStorage", { value: original, configurable: true });
}

function mockNavigatorLanguage(language: string) {
  const original = navigator.language;
  Object.defineProperty(navigator, "language", { value: language, configurable: true });
  return () => Object.defineProperty(navigator, "language", { value: original, configurable: true });
}

describe("detectInitialLocale", () => {
  const restoreFns: Array<() => void> = [];

  afterEach(() => {
    while (restoreFns.length) restoreFns.pop()!();
  });

  it("returns a stored valid locale when localStorage has one", () => {
    restoreFns.push(mockStorage("zh-Hans"), mockNavigatorLanguage("en"));
    expect(detectInitialLocale()).toBe("zh-Hans");
  });

  it("falls back through navigator.language when nothing is stored", () => {
    restoreFns.push(mockStorage(null), mockNavigatorLanguage("zh-CN"));
    expect(detectInitialLocale()).toBe("zh-Hans");
  });

  it("returns en when neither storage nor navigator yields a shipped locale", () => {
    restoreFns.push(mockStorage(null), mockNavigatorLanguage("fr-CA"));
    expect(detectInitialLocale()).toBe("en");
  });
});
