// Escapes a value for safe use inside a CSS attribute-selector string (`[data-x="..."]`). A source
// anchor or block id can contain quotes/brackets, so `CSS.escape` on the value keeps the selector
// well-formed. Falls back to a manual escape when `CSS.escape` is unavailable (older jsdom).
function escapeAttrValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return value.replace(/["\\]/g, "\\$&");
}

// Scrolls the reader to a block by its entry id and moves focus there, so a note card's
// "jump back" affordance returns the reader to the annotated text. When an `anchorId` is given
// (#550), it prefers the exact `[data-anchor-id]` element the cross-reference targets — a nested
// heading/figure/anchor — so the jump lands element-precisely, falling back to the block top only
// when that element is absent. A no-op when neither is currently rendered. Kept out of the React
// component so it tests in isolation.
export function scrollToBlock(
  blockEntryId: string,
  anchorId?: string,
  root: ParentNode = document
): void {
  const anchorElement =
    anchorId === undefined
      ? null
      : root.querySelector(`[data-anchor-id="${escapeAttrValue(anchorId)}"]`);

  const element =
    anchorElement instanceof HTMLElement
      ? anchorElement
      : root.querySelector(`[data-block-id="${escapeAttrValue(blockEntryId)}"]`);

  if (element instanceof HTMLElement) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus();
  }
}
