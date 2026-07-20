import { Link, Outlet, useLocation } from "react-router-dom";

import { SafeArea } from "../shared/ui/SafeArea.js";
import { ThemeToggle } from "../shared/theme/ThemeToggle.js";
import { ToastViewport } from "../shared/ui/toast/ToastViewport.js";
import { activeDestination, navDestinations } from "./navigation.js";

function navLinkClassName(isActive: boolean): string {
  // Mobile: each destination is an equal-width tab in a single non-wrapping row, sized to a >=44px
  // touch target (min-h/min-w) per #390. Six destinations (#679) still fit one non-scrolling row at
  // 320px because the label drops to 12px on mobile (`text-xs`) while desktop keeps 14px (`md:text-sm`).
  // Desktop: a left-aligned sidebar row that sizes to content.
  const base =
    "flex min-h-[44px] min-w-[44px] flex-1 items-center justify-center rounded px-1 py-2 text-xs font-medium whitespace-nowrap md:flex-none md:justify-start md:px-3 md:text-sm";

  return isActive
    ? `${base} bg-accent-selection text-accent`
    : `${base} text-text-muted hover:text-text`;
}

// The responsive app shell: one primary navigation (exactly six destinations, #638/#679 — Today, Library,
// Write, Recite, Notes, Diary) rendered as a left sidebar on desktop/tablet and a single-row bottom tab bar
// on mobile (a single nav landmark, repositioned with utilities), plus the routed content region. Wrapped in
// SafeArea so it respects dynamic viewport height and device safe-area insets.
//
// A destination's active state is derived from the current route through `activeDestination`, not from
// each link's own path, so a secondary surface keeps its parent visibly active (Recitation review → Recite,
// note Review → Notes) with one truthful highlight.
//
// SafeArea bounds the shell to exactly one viewport, so the routed <main> scrolls internally
// (min-h-0 lets the flex children shrink) and the mobile bottom nav stays pinned to the viewport edge
// as a stable single row — content growth never reflows or pushes it off-screen (#390).
//
// Search is a persistent shell utility (#638), not a primary tab: it lives in the slim top utility bar
// beside the theme toggle so it is always one action away without displacing a daily destination, and can
// never push the mobile bottom nav into a second row (#390). Every routed surface — including the reader
// and authored-work editor — is framed by this one shell so its parent destination stays visibly active
// (Reader keeps Library highlighted; the authored-Work editor keeps Write highlighted, #679) and Search
// stays one action away; each secondary surface additionally provides its own explicit back path to its parent.
export function AppShell(): React.JSX.Element {
  const location = useLocation();

  const active = activeDestination(location.pathname);

  return (
    <SafeArea>
      <div className="flex min-h-0 flex-1 flex-col bg-bg text-text md:flex-row">
        <nav
          aria-label="Primary"
          className="order-last flex shrink-0 gap-1 border-t border-border bg-surface p-2 md:order-first md:w-56 md:flex-col md:border-t-0 md:border-r"
        >
          {navDestinations.map((destination) => {
            const isActive = destination.to === active;
            return (
              <Link
                aria-current={isActive ? "page" : undefined}
                className={navLinkClassName(isActive)}
                key={destination.to}
                to={destination.to}
              >
                {destination.label}
              </Link>
            );
          })}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-end gap-1 border-b border-border bg-surface p-2">
            <Link
              className="flex min-h-[44px] items-center rounded px-3 py-2 text-sm font-medium whitespace-nowrap text-text-muted hover:text-text"
              to="/search"
            >
              Search
            </Link>
            <ThemeToggle />
          </div>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Outlet />
          </main>
        </div>
      </div>
      <ToastViewport />
    </SafeArea>
  );
}
