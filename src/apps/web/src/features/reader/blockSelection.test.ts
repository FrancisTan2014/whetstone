// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { readBlockSelection } from "./blockSelection";

function selectRange(node: Node, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);

  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);

  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("readBlockSelection", () => {
  it("returns the selected text and its start offset within the block", () => {
    document.body.innerHTML = '<div id="block"><p>the cat sat on the mat</p></div>';
    const block = document.getElementById("block") as HTMLElement;
    const textNode = block.querySelector("p")?.firstChild as Node;
    const selection = selectRange(textNode, 15, 18);

    expect(readBlockSelection(block, selection)).toEqual({
      selectedText: "the",
      startOffset: 15
    });
  });

  it("measures the offset across nested inline markup", () => {
    document.body.innerHTML = '<div id="block"><p>read <em>the</em> mat</p></div>';
    const block = document.getElementById("block") as HTMLElement;
    const emphasis = block.querySelector("em")?.firstChild as Node;
    const selection = selectRange(emphasis, 0, 3);

    expect(readBlockSelection(block, selection)).toEqual({
      selectedText: "the",
      startOffset: 5
    });
  });

  it("returns undefined when there is no selection object", () => {
    document.body.innerHTML = '<div id="block"><p>text</p></div>';
    const block = document.getElementById("block") as HTMLElement;

    expect(readBlockSelection(block, null)).toBeUndefined();
  });

  it("returns undefined when the selection has no range", () => {
    document.body.innerHTML = '<div id="block"><p>text</p></div>';
    const block = document.getElementById("block") as HTMLElement;
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();

    expect(readBlockSelection(block, selection)).toBeUndefined();
  });

  it("returns undefined when the selection starts outside the block", () => {
    document.body.innerHTML =
      '<div id="block"><p>inside</p></div><div id="other"><p>outside</p></div>';
    const block = document.getElementById("block") as HTMLElement;
    const otherNode = document.querySelector("#other p")?.firstChild as Node;
    const selection = selectRange(otherNode, 0, 3);

    expect(readBlockSelection(block, selection)).toBeUndefined();
  });
});
