import { NavLink, Outlet, useLocation } from "react-router-dom";

import { SafeArea } from "../shared/ui/SafeArea.js";
import { ThemeToggle } from "../shared/theme/ThemeToggle.js";
import { ToastViewport } from "../shared/ui/toast/ToastViewport.js";
import { navDestinations } from "./navigation.js";

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  // Mobile: each destination is an equal-width tab in a single non-wrapping row, sized to a >=44px
  // touch target (min-h/min-w) per #390. Desktop: a left-aligned sidebar row that sizes to content.
  const base =
    "flex min-h-[44px] min-w-[44px] flex-1 items-center justify-center rounded px-1 py-2 text-sm font-medium whitespace-nowrap md:flex-none md:justify-start md:px-3";

  return isActive
    ? `${base} bg-anno-thought-wash text-accent`
    : `${base} text-text-muted hover:text-text`;
}

// The responsive app shell: one primary navigation (exactly five destinations, #390) rendered as a
// left sidebar on desktop/tablet and a single-row bottom tab bar on mobile (a single nav landmark,
// repositioned with utilities), plus the routed content region. Wrapped in SafeArea so it respects
// dynamic viewport height and device safe-area insets.
//
// SafeArea bounds the shell to exactly one viewport, so the routed <main> scrolls internally
// (min-h-0 lets the flex children shrink) and the mobile bottom nav stays pinned to the viewport edge
// as a stable single row — content growth never reflows or pushes it off-screen (#390).
//
// The theme toggle is shell chrome in a slim top bar — never a primary tab — so it can never push the
// mobile bottom nav into a second row (#390). On the reader route the app navigation and the toggle
// bar recede so the reading column owns the full viewport (an immersive reading room): nothing but the
// routed content and the toast region renders. The reader provides its own back-to-Library affordance.
export function AppShell(): React.JSX.Element {
  const location = useLocation();

  if (location.pathname === "/reader" || location.pathname === "/write") {
    return (
      <SafeArea>
        <main className="min-h-0 flex-1 overflow-y-auto bg-bg text-text">
          <Outlet />
        </main>
        <ToastViewport />
      </SafeArea>
    );
  }

  return (
    <SafeArea>
      <div className="flex min-h-0 flex-1 flex-col bg-bg text-text md:flex-row">
        <nav
          aria-label="Primary"
          className="order-last flex shrink-0 gap-1 border-t border-border bg-surface p-2 md:order-first md:w-56 md:flex-col md:border-t-0 md:border-r"
        >
          {navDestinations.map((destination) => (
            <NavLink
              className={navLinkClassName}
              end={destination.end ?? false}
              key={destination.to}
              to={destination.to}
            >
              {destination.label}
            </NavLink>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex justify-end border-b border-border bg-surface p-2">
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
