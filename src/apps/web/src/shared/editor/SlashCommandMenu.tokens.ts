// Presentational class names for the slash command menu, isolated from behavior so the component test
// asserts semantics (roles, active option, counts) rather than styling. Excluded from coverage.
export const slashMenuClassNames = {
  activeOption: "richContentSlashMenuOption--active",
  empty: "richContentSlashMenuEmpty",
  list: "richContentSlashMenuList",
  option: "richContentSlashMenuOption",
  optionLabel: "richContentSlashMenuOptionLabel",
  root: "richContentSlashMenu",
  status: "sr-only"
} as const;
