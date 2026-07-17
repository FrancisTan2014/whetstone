export type NavDestination = Readonly<{
  // `end` marks the index route so it is only active on an exact match.
  end?: boolean;
  label: string;
  to: string;
}>;

// The primary navigation destinations (#573, #662): exactly four calm, product-facing modes — Today,
// Library, Notes, and Search. Today is the proactive landing (index route); Notes is where the learner
// browses and grows everything they have deliberately chosen to retain, and reviews what is due. Reader,
// Review, and Diary are secondary: Reader is an immersive destination opened from context; Today links to
// the Notes review; Library links to the all-notes surface. Notes occupies the former Memory position
// until #638 recomposes the shell into five destinations.
export const navDestinations: ReadonlyArray<NavDestination> = [
  { end: true, label: "Today", to: "/" },
  { label: "Library", to: "/library" },
  { label: "Notes", to: "/notes" },
  { label: "Search", to: "/search" }
];
