// Presentational class names for the Library's Radix dropdown menus — the header **Add** menu and each
// Work's **overflow** menu. Kept out of the components (like BlockActionsMenu.tokens) so their tests
// assert menu semantics — roles, item order, the action each item runs, accessible names — rather than
// styling. They reuse the shared dropdown surface styling defined in theme.css. Excluded from coverage.
export const libraryMenuClassNames = {
  content: "libraryMenu",
  destructiveItem: "libraryMenuItem libraryMenuItem--destructive",
  item: "libraryMenuItem",
  separator: "libraryMenuSeparator"
} as const;
