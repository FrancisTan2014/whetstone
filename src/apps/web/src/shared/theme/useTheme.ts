import { useCallback, useEffect, useState } from "react";

import { nextTheme, resolveInitialTheme, themeStorageKey, type Theme } from "./theme.js";

// Read the active theme from the browser: a persisted choice, else the system
// preference. Only ever runs client-side (the toggle is mounted in the browser), so no
// SSR guard is needed.
function readBrowserTheme(): Theme {
  const stored = window.localStorage.getItem(themeStorageKey);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

  return resolveInitialTheme(stored, prefersDark);
}

export type ThemeController = Readonly<{
  theme: Theme;
  toggle: () => void;
}>;

// Owns the active theme: applies it to the root element with the `class` strategy
// (`.dark` for Night), persists the choice, and exposes a toggle. The applying effect
// also runs on first mount so the document reflects the resolved theme immediately.
export function useTheme(): ThemeController {
  const [theme, setTheme] = useState<Theme>(readBrowserTheme);

  useEffect(() => {
    const root = document.documentElement;

    if (theme === "night") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }

    window.localStorage.setItem(themeStorageKey, theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => nextTheme(current));
  }, []);

  return { theme, toggle };
}
