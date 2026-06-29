// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  eventTargetClosest,
  isCrossBlockSelection,
  readBlockSelection,
  releasedBlockElement
} from "./blockSelection";

function selectRange(node: Node, start: number, end: number): Selection {
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);

  const selection = window.getSelection() as Selection;
  selection.removeAllRanges();
  selection.addRange(range);

  return selection;
}

function selectAcross(
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number
): Selection {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);

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
  it("returns the selected text and the text preceding it within the block", () => {
    document.body.innerHTML = '<div id="block"><p>the cat sat on the mat</p></div>';
    const block = document.getElementById("block") as HTMLElement;
    const textNode = block.querySelector("p")?.firstChild as Node;
    const selection = selectRange(textNode, 15, 18);

    expect(readBlockSelection(block, selection)).toEqual({
      precedingText: "the cat sat on ",
      selectedText: "the"
    });
  });

  it("measures the preceding text across nested inline markup", () => {
    document.body.innerHTML = '<div id="block"><p>read <em>the</em> mat</p></div>';
    const block = document.getElementById("block") as HTMLElement;
    const emphasis = block.querySelector("em")?.firstChild as Node;
    const selection = selectRange(emphasis, 0, 3);

    expect(readBlockSelection(block, selection)).toEqual({
      precedingText: "read ",
      selectedText: "the"
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

describe("isCrossBlockSelection", () => {
  function buildTwoBlocks(): { a: Node; b: Node } {
    document.body.innerHTML =
      '<div class="reader">' +
      '<div data-block-id="b1"><p>first block</p></div>' +
      '<div data-block-id="b2"><p>second block</p></div>' +
      "</div>";

    return {
      a: document.querySelector('[data-block-id="b1"] p')?.firstChild as Node,
      b: document.querySelector('[data-block-id="b2"] p')?.firstChild as Node
    };
  }

  it("is true when the selection starts in one block and ends in another", () => {
    const { a, b } = buildTwoBlocks();

    expect(isCrossBlockSelection(selectAcross(a, 0, b, 6))).toBe(true);
  });

  it("is true when the selection endpoints are the block elements themselves", () => {
    buildTwoBlocks();
    const blockA = document.querySelector('[data-block-id="b1"]') as Element;
    const blockB = document.querySelector('[data-block-id="b2"]') as Element;

    // Element containers (not text nodes) exercise the `node instanceof Element` path; a non-zero end
    // offset means content in b2 is genuinely selected.
    expect(isCrossBlockSelection(selectAcross(blockA, 0, blockB, 1))).toBe(true);
  });

  it("treats a whole-block selection ending at offset 0 of the next block as single-block (#260)", () => {
    const { a, b } = buildTwoBlocks();

    // Selecting to a paragraph's end lands the range end at offset 0 of the next block with nothing
    // selected there — that is the whole first block, not a cross-block selection.
    expect(isCrossBlockSelection(selectAcross(a, 0, b, 0))).toBe(false);
  });

  it("is false for a selection contained in a single block", () => {
    const { a } = buildTwoBlocks();

    expect(isCrossBlockSelection(selectAcross(a, 0, a, 5))).toBe(false);
  });

  it("is false for a collapsed selection", () => {
    const { a } = buildTwoBlocks();

    expect(isCrossBlockSelection(selectAcross(a, 2, a, 2))).toBe(false);
  });

  it("is false when there is no selection object or no range", () => {
    buildTwoBlocks();
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();

    expect(isCrossBlockSelection(null)).toBe(false);
    expect(isCrossBlockSelection(selection)).toBe(false);
  });

  it("is false when the endpoints are outside any block", () => {
    document.body.innerHTML = '<div id="x">plain text here</div>';
    const node = document.getElementById("x")?.firstChild as Node;

    expect(isCrossBlockSelection(selectAcross(node, 0, node, 5))).toBe(false);
  });

  it("is false when only the start is inside a block", () => {
    document.body.innerHTML =
      '<div class="reader"><div data-block-id="b1"><p>first block</p></div>' +
      '<span id="loose">loose</span></div>';
    const a = document.querySelector('[data-block-id="b1"] p')?.firstChild as Node;
    const loose = document.getElementById("loose")?.firstChild as Node;

    expect(isCrossBlockSelection(selectAcross(a, 0, loose, 3))).toBe(false);
  });

  it("is false when an endpoint is a node with no parent element", () => {
    // A range container can be the document node itself, which is not an Element and has no parent
    // element — exercises the null-element branch of the block lookup.
    const range = document.createRange();
    range.setStart(document, 0);
    range.setEnd(document, document.childNodes.length);
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(isCrossBlockSelection(selection)).toBe(false);
  });
});

describe("eventTargetClosest", () => {
  it("returns the matching ancestor when the target is an element", () => {
    document.body.innerHTML = '<div class="reader"><span id="inner">x</span></div>';
    const inner = document.getElementById("inner") as HTMLElement;

    expect(eventTargetClosest(inner, ".reader")?.className).toBe("reader");
  });

  it("returns null when the element has no matching ancestor", () => {
    document.body.innerHTML = '<span id="inner">x</span>';
    const inner = document.getElementById("inner") as HTMLElement;

    expect(eventTargetClosest(inner, ".reader")).toBeNull();
  });

  it("returns null when the target is not an element", () => {
    expect(eventTargetClosest(null, ".reader")).toBeNull();
    expect(eventTargetClosest(document.createTextNode("x"), ".reader")).toBeNull();
  });
});

describe("releasedBlockElement", () => {
  function buildReader(): { block: HTMLElement; gap: HTMLElement; reader: HTMLElement } {
    document.body.innerHTML =
      '<div class="reader">' +
      '<div data-block-id="b1"><p>hello world</p></div>' +
      '<div id="gap">&nbsp;</div>' +
      "</div>";
    const reader = document.querySelector(".reader") as HTMLElement;
    const block = document.querySelector("[data-block-id]") as HTMLElement;
    const gap = document.getElementById("gap") as HTMLElement;

    return { block, gap, reader };
  }

  function selectIn(node: Node, start: number, end: number): Selection {
    return selectRange(node, start, end);
  }

  it("resolves the block whose text the selection starts in when released in a reader gap", () => {
    const { block, gap } = buildReader();
    const selection = selectIn(block.querySelector("p")?.firstChild as Node, 0, 5);

    expect(releasedBlockElement(gap, selection, [block])).toBe(block);
  });

  it("returns undefined when the release lands on a block (a per-block handler owns it)", () => {
    const { block } = buildReader();
    const selection = selectIn(block.querySelector("p")?.firstChild as Node, 0, 5);

    expect(releasedBlockElement(block, selection, [block])).toBeUndefined();
  });

  it("returns undefined when the release is outside the reader", () => {
    const { block } = buildReader();
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    const selection = selectIn(block.querySelector("p")?.firstChild as Node, 0, 5);

    expect(releasedBlockElement(outside, selection, [block])).toBeUndefined();
  });

  it("returns undefined when there is no selection object", () => {
    const { gap, block } = buildReader();

    expect(releasedBlockElement(gap, null, [block])).toBeUndefined();
  });

  it("returns undefined when the selection has no range", () => {
    const { gap, block } = buildReader();
    const selection = window.getSelection() as Selection;
    selection.removeAllRanges();

    expect(releasedBlockElement(gap, selection, [block])).toBeUndefined();
  });

  it("returns undefined when the selection starts in none of the given blocks", () => {
    const { gap, block } = buildReader();
    // Select within the gap itself, which is not one of the candidate block elements.
    const selection = selectIn(gap.firstChild as Node, 0, 1);

    expect(releasedBlockElement(gap, selection, [block])).toBeUndefined();
  });
});
