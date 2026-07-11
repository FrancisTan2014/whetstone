// Presentational class names for the block-actions menu, its "Turn into" submenu, and the gutter
// grip / compact trigger. Kept out of the component so its tests assert menu semantics (roles,
// disabled state, the actions each item runs, focus restoration) rather than styling. Excluded from
// coverage.
export const blockActionsMenuClassNames = {
  content: "blockActionsMenu",
  destructiveItem: "blockActionsMenuItem blockActionsMenuItem--destructive",
  grip: "blockGutterGrip",
  hint: "sr-only",
  item: "blockActionsMenuItem",
  moreTrigger: "blockGutterMoreTrigger",
  separator: "blockActionsMenuSeparator",
  subContent: "blockActionsMenu blockActionsSubmenu",
  subTrigger: "blockActionsMenuItem blockActionsMenuItem--sub"
} as const;
