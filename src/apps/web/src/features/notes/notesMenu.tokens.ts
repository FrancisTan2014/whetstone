// Presentational class names for the Notes header's Radix overflow menu (#641). Kept out of the
// component (like libraryMenu.tokens) so its test asserts menu semantics — role, the Import action it
// runs, accessible name — rather than styling. They reuse the shared dropdown surface styling defined
// in theme.css. Excluded from coverage.
export const notesMenuClassNames = {
  content: "notesMenu",
  item: "notesMenuItem"
} as const;
