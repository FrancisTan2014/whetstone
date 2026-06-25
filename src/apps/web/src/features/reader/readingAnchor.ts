// Find the topmost block still in view: the first `[data-block-id]` element in reading order whose
// bottom edge is below the viewport top (i.e. it sits at or just below the top edge and is still at
// least partly visible). Returns undefined when no block qualifies (nothing rendered, or every
// block scrolled past the top). The document is injectable so this tests without real layout.
export function topmostVisibleBlockId(root: ParentNode = document): string | undefined {
  const elements = root.querySelectorAll<HTMLElement>("[data-block-id]");

  for (const element of elements) {
    if (element.getBoundingClientRect().bottom > 0) {
      return element.dataset.blockId;
    }
  }

  return undefined;
}
