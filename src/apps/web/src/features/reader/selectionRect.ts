// Reads the bounding rectangle of the active selection's first range so the selection
// toolbar can anchor itself to the selected text. Returns undefined when there is no
// usable selection, or when the range cannot be measured (jsdom does not implement
// Range.getBoundingClientRect) — callers then render the toolbar without a fixed anchor.
export function selectionRect(selection: Selection | null): DOMRect | undefined {
  if (selection === null || selection.rangeCount === 0) {
    return undefined;
  }

  const range = selection.getRangeAt(0);

  return typeof range.getBoundingClientRect === "function"
    ? range.getBoundingClientRect()
    : undefined;
}
