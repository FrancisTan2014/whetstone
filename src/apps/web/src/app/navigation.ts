export type NavDestination = Readonly<{
  // `end` marks the index route so it is only active on an exact match.
  end?: boolean;
  label: string;
  to: string;
}>;

// The primary navigation destinations (#390): exactly five calm, product-facing modes. Today is the
// proactive landing (index route); Progress keeps its route but its user-facing label is "Map"
// (the fog-of-war mastery view). Reader, Recall, Notes, and Diary are NOT primary — Reader is an
// immersive destination opened from context, and the others are secondary surfaces reached from the
// places that need them (Today links to Recall/Diary; Library links to the all-notes surface).
export const navDestinations: ReadonlyArray<NavDestination> = [
  { end: true, label: "Today", to: "/" },
  { label: "Library", to: "/library" },
  { label: "Practice", to: "/practice" },
  { label: "Map", to: "/progress" },
  { label: "Search", to: "/search" }
];
