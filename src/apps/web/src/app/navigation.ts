export type NavDestination = Readonly<{
  // `end` marks the index route so it is only active on an exact match.
  end?: boolean;
  label: string;
  to: string;
}>;

// The primary navigation modes. Today is the proactive landing (index route); Library and Reader
// mount existing screens; Notes and Search are placeholder regions until their feature slices land.
export const navDestinations: ReadonlyArray<NavDestination> = [
  { end: true, label: "Today", to: "/" },
  { label: "Library", to: "/library" },
  { label: "Reader", to: "/reader" },
  { label: "Practice", to: "/practice" },
  { label: "Progress", to: "/progress" },
  { label: "Recall", to: "/recall" },
  { label: "Notes", to: "/notes" },
  { label: "Diary", to: "/diary" },
  { label: "Search", to: "/search" }
];
