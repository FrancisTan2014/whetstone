// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { selectionRect } from "./selectionRect.js";

function selectContentsOf(host: HTMLElement): Selection {
  const range = document.createRange();
  range.selectNodeContents(host.firstChild as Text);
  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);

  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  delete (Range.prototype as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
});

describe("selectionRect", () => {
  it("returns undefined when there is no selection", () => {
    expect(selectionRect(null)).toBeUndefined();
  });

  it("returns undefined when the selection has no range", () => {
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();

    expect(selectionRect(selection)).toBeUndefined();
  });

  it("returns undefined when the range cannot be measured", () => {
    const host = document.createElement("p");
    host.textContent = "anchored text";
    document.body.appendChild(host);

    expect(selectionRect(selectContentsOf(host))).toBeUndefined();

    host.remove();
  });

  it("returns the bounding rect when the range can be measured", () => {
    const rect = { bottom: 24, left: 8, top: 16 } as DOMRect;
    (Range.prototype as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect = () =>
      rect;

    const host = document.createElement("p");
    host.textContent = "anchored text";
    document.body.appendChild(host);

    expect(selectionRect(selectContentsOf(host))).toBe(rect);

    host.remove();
  });
});
