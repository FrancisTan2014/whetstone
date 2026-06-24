import { useTheme } from "./useTheme.js";

// A Day/Night switch rendered as a sun/moon icon button. It lives in the app shell
// (sidebar footer on desktop, bottom bar on mobile). The accessible name reflects the
// action, `aria-pressed` reports the current mode, and the inline SVG (sun shown in Night,
// moon in Day) keeps the control dependency-free. Colors come from tokens only.
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
        <svg
          aria-hidden="true"
          className="h-5 w-5"
          fill="none"
          focusable="false"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      ) : (
        <svg
          aria-hidden="true"
          className="h-5 w-5"
          fill="none"
          focusable="false"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
