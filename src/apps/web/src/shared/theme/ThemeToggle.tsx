import { useTheme } from "./useTheme.js";

// A minimal Day/Night switch. It is mounted at the composition root for now; the app
// shell gives it a permanent home in a later slice. Labelled by its action and exposes
// `aria-pressed` so the control is keyboard- and screen-reader-usable.
export function ThemeToggle(): React.JSX.Element {
  const { theme, toggle } = useTheme();
  const isNight = theme === "night";

  return (
    <button
      aria-pressed={isNight}
      className="rounded border border-border bg-surface px-3 py-2 text-sm text-text"
      onClick={toggle}
      type="button"
    >
      {isNight ? "Switch to Day" : "Switch to Night"}
    </button>
  );
}
