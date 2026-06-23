import { describe, expect, it } from "vitest";

import { isTheme, nextTheme, resolveInitialTheme, themeStorageKey } from "./theme.js";

describe("theme", () => {
  it("recognizes valid themes only", () => {
    expect(isTheme("day")).toBe(true);
    expect(isTheme("night")).toBe(true);
    expect(isTheme("dusk")).toBe(false);
    expect(isTheme(null)).toBe(false);
  });

  it("keeps a previously persisted choice over the system preference", () => {
    expect(resolveInitialTheme("night", false)).toBe("night");
    expect(resolveInitialTheme("day", true)).toBe("day");
  });

  it("falls back to the system preference, then Day, on first load", () => {
    expect(resolveInitialTheme(null, true)).toBe("night");
    expect(resolveInitialTheme(null, false)).toBe("day");
    expect(resolveInitialTheme("bogus", true)).toBe("night");
  });

  it("toggles between Day and Night", () => {
    expect(nextTheme("day")).toBe("night");
    expect(nextTheme("night")).toBe("day");
  });

  it("exposes a stable storage key", () => {
    expect(themeStorageKey).toBe("whetstone-theme");
  });
});
