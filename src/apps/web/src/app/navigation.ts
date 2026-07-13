export type NavDestination = Readonly<{
  // `end` marks the index route so it is only active on an exact match.
  end?: boolean;
  label: string;
  to: string;
}>;

// The primary navigation destinations (#573): exactly four calm, product-facing modes — Today, Library,
// Memory, and Search. Today is the proactive landing (index route); Memory is where the learner browses
// and grows everything they have deliberately chosen to retain. Reader, Recall, Notes, and Diary are
// secondary: Reader is an immersive destination opened from context; Today links to Recall/Diary;
// Library links to the all-notes surface.
export const navDestinations: ReadonlyArray<NavDestination> = [
  { end: true, label: "Today", to: "/" },
  { label: "Library", to: "/library" },
  { label: "Memory", to: "/memory" },
  { label: "Search", to: "/search" }
];
