import { Moon, Sun } from "lucide-react";

import { IconButton } from "../ui/Button.js";
import { useTheme } from "./useTheme.js";

// A Day/Night switch rendered as a sun/moon icon button. It lives in the app shell
// (sidebar footer on desktop, bottom bar on mobile). It routes through the shared IconButton
// boundary for its 44px target and visible focus, so the accessible name reflects the action,
// `aria-pressed` reports the current mode, and the lucide icon (sun shown in Night, moon in Day)
// is decorative. Colors come from tokens only.
export function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const isNight = theme === "night";
  const label = isNight ? "Switch to Day" : "Switch to Night";

  return (
    <IconButton
      aria-pressed={isNight}
      icon={
        isNight ? (
          <Sun aria-hidden className="h-5 w-5" focusable="false" strokeWidth={1.75} />
        ) : (
          <Moon aria-hidden className="h-5 w-5" focusable="false" strokeWidth={1.75} />
        )
      }
      label={label}
      onClick={toggle}
      variant="ghost"
    />
  );
}
