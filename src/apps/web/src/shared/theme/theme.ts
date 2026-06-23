// Day/Night theme primitives. Pure logic only — no DOM, storage, or React — so the
// resolution rules (default Day, persisted choice, first-load system preference) are
// testable in isolation. The browser wiring lives in `useTheme.ts`.

export type Theme = "day" | "night";

// The persisted-preference key. Kept stable so a returning visitor keeps their choice.
export const themeStorageKey = "whetstone-theme";

export function isTheme(value: unknown): value is Theme {
  return value === "day" || value === "night";
}

// The initial theme: a previously persisted choice wins; otherwise the system
// preference decides on first load; absent both, Day is the default.
export function resolveInitialTheme(stored: string | null, prefersDark: boolean): Theme {
  if (isTheme(stored)) {
    return stored;
  }

  return prefersDark ? "night" : "day";
}

export function nextTheme(theme: Theme): Theme {
  return theme === "day" ? "night" : "day";
}
