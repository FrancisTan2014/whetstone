import { NavLink, Outlet } from "react-router-dom";

import { SafeArea } from "../shared/ui/SafeArea.js";
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
export function AppShell(): React.JSX.Element {
  return (
    <SafeArea>
      <div className="flex min-h-full flex-col bg-bg text-text md:flex-row">
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
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </SafeArea>
  );
}
