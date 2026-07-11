// The class the block-gutter wash decoration carries. Isolated from the extension so the plugin logic
// tests assert the decoration is applied to the right block (by class presence) rather than styling,
// and the visual treatment lives in theme.css. Excluded from coverage.
export const blockGutterHighlightClass = "is-block-gutter-active";
