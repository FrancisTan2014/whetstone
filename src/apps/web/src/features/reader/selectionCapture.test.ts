// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { captureSelectionAnchor, eventTargetClosest } from "./selectionCapture";

afterEach(() => {
  document.body.innerHTML = "";
});

function reader(html: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "reader";
  container.innerHTML = html;
  document.body.append(container);

  return container;
}

function firstText(element: Element): Text {
  return element.firstChild as Text;
}

// A minimal Selection over one range — the only members `captureSelectionAnchor` reads.
function selectionOf(range: Range | undefined): Selection {
  return {
    getRangeAt: () => range,
    isCollapsed: range?.collapsed ?? true,
    rangeCount: range === undefined ? 0 : 1
  } as unknown as Selection;
}

function rangeIn(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);

  return range;
}

describe("eventTargetClosest", () => {
  it("matches an Element target against the selector", () => {
    const container = reader("<p>x</p>");

    expect(eventTargetClosest(container, ".reader")).toBe(container);
  });

  it("returns null for a non-Element target", () => {
    expect(eventTargetClosest(null, ".reader")).toBeNull();
  });
});

describe("captureSelectionAnchor", () => {
  const html =
    '<div data-block-id="b1">First block.</div><div data-block-id="b2">Second block.</div>';

  it("returns undefined for a null selection", () => {
    expect(captureSelectionAnchor(null, reader(html))).toBeUndefined();
  });

  it("returns undefined when there is no range", () => {
    expect(captureSelectionAnchor(selectionOf(undefined), reader(html))).toBeUndefined();
  });

  it("returns undefined for a collapsed selection", () => {
    const container = reader(html);
    const block = container.querySelector('[data-block-id="b1"]') as HTMLElement;

    expect(
      captureSelectionAnchor(
        selectionOf(rangeIn(firstText(block), 1, firstText(block), 1)),
        container
      )
    ).toBeUndefined();
  });

  it("returns undefined for a whitespace-only selection", () => {
    const container = reader('<div data-block-id="w">   </div>');
    const block = container.querySelector('[data-block-id="w"]') as HTMLElement;

    expect(
      captureSelectionAnchor(
        selectionOf(rangeIn(firstText(block), 0, firstText(block), 3)),
        container
      )
    ).toBeUndefined();
  });

  it("captures a sub-block selection with its offsets and snapshot", () => {
    const container = reader(html);
    const b1 = container.querySelector('[data-block-id="b1"]') as HTMLElement;

    const draft = captureSelectionAnchor(
      selectionOf(rangeIn(firstText(b1), 6, firstText(b1), 11)),
      container
    );

    expect(draft).toMatchObject({
      blockEntryId: "b1",
      contextSnapshot: "First block.",
      endOffset: 11,
      selectedText: "block",
      startOffset: 6
    });
  });

  it("drops the offsets when the selection covers the whole block", () => {
    const container = reader(html);
    const b1 = container.querySelector('[data-block-id="b1"]') as HTMLElement;

    const draft = captureSelectionAnchor(
      selectionOf(rangeIn(firstText(b1), 0, firstText(b1), "First block.".length)),
      container
    );

    expect(draft?.selectedText).toBe("First block.");
    expect(draft?.startOffset).toBeUndefined();
    expect(draft?.endOffset).toBeUndefined();
  });

  it("records both block ids and offsets for a cross-block selection", () => {
    const container = reader(html);
    const b1 = container.querySelector('[data-block-id="b1"]') as HTMLElement;
    const b2 = container.querySelector('[data-block-id="b2"]') as HTMLElement;

    const draft = captureSelectionAnchor(
      selectionOf(rangeIn(firstText(b1), 6, firstText(b2), 6)),
      container
    );

    expect(draft).toMatchObject({
      blockEntryId: "b1",
      endBlockEntryId: "b2",
      endOffset: 6,
      startOffset: 6
    });
    expect(draft?.selectedText).toContain("block.");
    expect(draft?.selectedText).toContain("Second");
  });

  it("collapses a selection that ends at offset 0 of the next block to the start block (#260)", () => {
    const container = reader(html);
    const b1 = container.querySelector('[data-block-id="b1"]') as HTMLElement;
    const b2 = container.querySelector('[data-block-id="b2"]') as HTMLElement;

    const draft = captureSelectionAnchor(
      selectionOf(rangeIn(firstText(b1), 6, firstText(b2), 0)),
      container
    );

    expect(draft).toMatchObject({
      blockEntryId: "b1",
      endOffset: "First block.".length,
      selectedText: "block.",
      startOffset: 6
    });
    expect(draft?.endBlockEntryId).toBeUndefined();
  });

  it("resolves the block when the selection node is the block element itself", () => {
    const container = reader(html);
    const b1 = container.querySelector('[data-block-id="b1"]') as HTMLElement;

    // A Selection anchored at an element node (child-index offsets), not a Text node.
    const draft = captureSelectionAnchor(selectionOf(rangeIn(b1, 0, b1, 1)), container);

    expect(draft).toMatchObject({ blockEntryId: "b1", selectedText: "First block." });
    expect(draft?.startOffset).toBeUndefined();
  });

  it("returns undefined when the selection starts outside any block", () => {
    const container = reader(html);
    const detached = document.createTextNode("hello world");

    expect(
      captureSelectionAnchor(selectionOf(rangeIn(detached, 0, detached, 5)), container)
    ).toBeUndefined();
  });

  it("returns undefined when the selection starts in a block outside this reader", () => {
    const container = reader(html);
    const outside = document.createElement("div");
    outside.setAttribute("data-block-id", "out");
    outside.textContent = "Outside text.";
    document.body.append(outside);

    expect(
      captureSelectionAnchor(
        selectionOf(rangeIn(firstText(outside), 0, firstText(outside), 7)),
        container
      )
    ).toBeUndefined();
  });

  it("returns undefined when the selection ends outside any block", () => {
    const container = reader(html);
    const b1 = container.querySelector('[data-block-id="b1"]') as HTMLElement;
    const outside = document.createElement("div");
    outside.textContent = "Outside text.";
    document.body.append(outside);

    expect(
      captureSelectionAnchor(
        selectionOf(rangeIn(firstText(b1), 0, firstText(outside), 7)),
        container
      )
    ).toBeUndefined();
  });
});
