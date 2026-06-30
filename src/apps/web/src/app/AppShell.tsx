import { NavLink, Outlet, useLocation } from "react-router-dom";

import { SafeArea } from "../shared/ui/SafeArea.js";
import { ThemeToggle } from "../shared/theme/ThemeToggle.js";
import { ToastViewport } from "../shared/ui/toast/ToastViewport.js";
import { navDestinations } from "./navigation.js";

function navLinkClassName({ isActive }: { isActive: boolean }): string {
  const base =
    "flex items-center justify-center rounded px-3 py-2 text-sm font-medium md:justify-start";

  return isActive
    ? `${base} bg-anno-thought-wash text-accent`
    : `${base} text-text-muted hover:text-text`;
}

// The responsive app shell: one primary navigation rendered as a left sidebar on
// desktop/tablet and a bottom tab bar on mobile (a single nav landmark, repositioned
// with utilities), plus the routed content region. Wrapped in SafeArea so it respects
// dynamic viewport height and device safe-area insets.
//
// On the reader route the app navigation recedes so the reading column owns the full
// viewport (an immersive reading room): the nav (and the theme toggle it hosts) is not
// rendered and the routed content goes full-bleed. The reader provides its own
// back-to-Library affordance. Every other route keeps the primary nav.
export function AppShell(): React.JSX.Element {
  const location = useLocation();

  if (location.pathname === "/reader") {
    return (
      <SafeArea>
        <main className="flex-1 overflow-y-auto bg-bg text-text">
          <Outlet />
        </main>
        <ToastViewport />
      </SafeArea>
    );
  }

  return (
    <SafeArea>
      <div className="flex flex-1 flex-col bg-bg text-text md:flex-row">
        <nav
          aria-label="Primary"
          className="order-last flex flex-wrap shrink-0 gap-1 border-t border-border bg-surface p-2 md:order-first md:w-56 md:flex-col md:flex-nowrap md:border-t-0 md:border-r"
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
          <div className="flex items-center justify-center md:mt-auto md:justify-start">
            <ThemeToggle />
          </div>
        </nav>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <ToastViewport />
    </SafeArea>
  );
}
