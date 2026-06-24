// Scrolls the reader to a block by its entry id and moves focus there, so a note card's
// "jump back" affordance returns the reader to the annotated text. A no-op when the block
// is not currently rendered. Kept out of the React component so it tests in isolation.
export function scrollToBlock(blockEntryId: string, root: ParentNode = document): void {
  const element = root.querySelector(`[data-block-id="${blockEntryId}"]`);

  if (element instanceof HTMLElement) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.focus();
  }
}
