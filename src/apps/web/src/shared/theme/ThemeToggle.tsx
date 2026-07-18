import { Moon, Sun } from "lucide-react";

import { useTheme } from "./useTheme.js";

// A Day/Night switch rendered as a sun/moon icon button. It lives in the app shell
// (sidebar footer on desktop, bottom bar on mobile). The accessible name reflects the
// action, `aria-pressed` reports the current mode, and the lucide icon (sun shown in Night,
// moon in Day) is decorative. Colors come from tokens only.
export function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const isNight = theme === "night";
  const label = isNight ? "Switch to Day" : "Switch to Night";

  return (
    <button
      aria-label={label}
      aria-pressed={isNight}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded text-text-muted transition-colors hover:bg-bg hover:text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={toggle}
      title={label}
      type="button"
    >
      {isNight ? (
        <Sun aria-hidden className="h-5 w-5" focusable="false" strokeWidth={1.75} />
      ) : (
        <Moon aria-hidden className="h-5 w-5" focusable="false" strokeWidth={1.75} />
      )}
    </button>
  );
}
