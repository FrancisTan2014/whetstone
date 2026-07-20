export type NavDestination = Readonly<{
  // `end` marks the index route so it is only active on an exact match.
  end?: boolean;
  label: string;
  to: string;
}>;

// The primary navigation destinations (#638, #679): exactly six calm, product-facing modes that name
// durable learner modes — Today (the proactive landing/index route), Library, Write, Recite, Notes, and
// Diary. Search is a persistent shell utility, not a destination; Reader is secondary under Library, the
// authored-Work editor is secondary under Write, note Review is secondary under Notes, and the Recitation
// review is secondary under Recite (see `activeDestination`).
export const navDestinations: ReadonlyArray<NavDestination> = [
  { end: true, label: "Today", to: "/" },
  { label: "Library", to: "/library" },
  { label: "Write", to: "/write" },
  { label: "Recite", to: "/recite" },
  { label: "Notes", to: "/notes" },
  { label: "Diary", to: "/diary" }
];

// Every secondary route mapped to the one primary destination that owns it, so a secondary surface keeps
// its parent visibly active (Reader → Library; the authored-Work editor → Write, #679; Recitation review →
// Recite; note Review → Notes). The retired Memory/Recall links resolve to Notes, matching their redirect
// target, so the parent stays truthful even for the render before the redirect settles. Prefixes never
// overlap, so order is irrelevant.
const routeParents: ReadonlyArray<readonly [string, string]> = [
  ["/library", "/library"],
  ["/reader", "/library"],
  ["/write", "/write"],
  ["/recite", "/recite"],
  ["/recitation", "/recite"],
  ["/notes", "/notes"],
  ["/memory", "/notes"],
  ["/recall", "/notes"],
  ["/diary", "/diary"]
];

// The primary destination that owns a given route, or null when none does. Today owns only the exact
// index route; every other destination also owns its nested and secondary routes. Search and any unknown
// route own no destination, so no primary tab is falsely marked active on those surfaces.
export function activeDestination(pathname: string): string | null {
  if (pathname === "/") {
    return "/";
  }
  const path = pathname.replace(/\/+$/, "");
  for (const [prefix, parent] of routeParents) {
    if (path === prefix || path.startsWith(`${prefix}/`)) {
      return parent;
    }
  }
  return null;
}
