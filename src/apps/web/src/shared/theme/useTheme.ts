import { useCallback, useEffect, useState } from "react";

import { fetchPreferences, savePreferences } from "../preferences/preferencesApi.js";
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

// Owns the active theme: applies it to the root element with the `class` strategy (`.dark` for Night),
// caches the choice in localStorage for an instant first paint, and reconciles from the server (the
// source of truth, #234) on mount so it restores on any device. Toggling persists best-effort.
export function useTheme(): ThemeController {
  const [theme, setTheme] = useState<Theme>(readBrowserTheme);

  useEffect(() => {
    void fetchPreferences().then((prefs) => setTheme(prefs.theme));
  }, []);

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
    setTheme((current) => {
      const updated = nextTheme(current);
      void savePreferences({ theme: updated });
      return updated;
    });
  }, []);

  return { theme, toggle };
}
