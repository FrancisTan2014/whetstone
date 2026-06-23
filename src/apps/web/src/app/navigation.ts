export type NavDestination = Readonly<{
  // `end` marks the index route so it is only active on an exact match.
  end?: boolean;
  label: string;
  to: string;
}>;

// The primary navigation modes. Library and Reader mount existing screens; Notes and
// Search are placeholder regions until their feature slices land.
export const navDestinations: ReadonlyArray<NavDestination> = [
  { end: true, label: "Library", to: "/" },
  { label: "Reader", to: "/reader" },
  { label: "Notes", to: "/notes" },
  { label: "Search", to: "/search" }
];
