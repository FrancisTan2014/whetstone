// Presentational class names for the shared Note/Cards workspace — the Note|Cards mode tablist, the
// Sheet-header overflow menu (Delete note), the Cards list rows and their chevron, and the card
// detail/history scaffolding. Kept out of the components (like `libraryMenu.tokens`) so their tests can
// assert behavior — roles, selection, navigation, the command each control runs — rather than styling.
// The overflow reuses the shared Radix dropdown surface (`.libraryMenu*` in `styles/theme.css`).
// Excluded from coverage.
export const noteWorkspaceClassNames = {
  overflowContent: "libraryMenu",
  overflowItem: "libraryMenuItem",
  overflowDestructiveItem: "libraryMenuItem libraryMenuItem--destructive"
} as const;
