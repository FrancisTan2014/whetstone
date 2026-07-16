// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { applyNoteHighlights, noteHighlightDescriptors } from "./applyNoteHighlights";

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

function note(
  anchor: AnchoredNoteDto["anchor"],
  overrides: Partial<AnchoredNoteDto> = {}
): AnchoredNoteDto {
  return {
    blockEntryId: anchor.blockEntryId,
    bodyDoc: createTextDocument("a note"),
    bodyText: "a note",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
    anchor
  };
}

function marks(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".noteMark"));
}

function dispatch(el: Element, event: Event): Event {
  el.dispatchEvent(event);

  return event;
}

function click(el: Element): void {
  dispatch(el, new MouseEvent("click", { bubbles: true }));
}

function keydown(el: Element, key: string): KeyboardEvent {
  return dispatch(
    el,
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key })
  ) as KeyboardEvent;
}

function selectText(node: Node): void {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

const subBlockAnchor = {
  blockEntryId: toEntryId("b1"),
  contextSnapshot: "First block text.",
  endBlockEntryId: toEntryId("b1"),
  endOffset: 11,
  selectedTextSnapshot: "block",
  startOffset: 6
} as AnchoredNoteDto["anchor"];

describe("noteHighlightDescriptors", () => {
  it("skips a whole-block note that has no offsets", () => {
    expect(
      noteHighlightDescriptors([
        note({
          blockEntryId: toEntryId("b1"),
          contextSnapshot: "First block.",
          endBlockEntryId: toEntryId("b1"),
          selectedTextSnapshot: "First block."
        })
      ])
    ).toEqual([]);
  });

  it("derives a bounded prefix/suffix from the context snapshot for a single-block note", () => {
    const [descriptor] = noteHighlightDescriptors([note(subBlockAnchor)]);

    expect(descriptor).toMatchObject({
      exact: "block",
      prefix: "First ",
      startBlockEntryId: "b1",
      suffix: " text."
    });
  });

  it("emits no suffix for a cross-block note and defaults the end block when absent", () => {
    const [crossBlock] = noteHighlightDescriptors([
      note({
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b2"),
        endOffset: 6,
        selectedTextSnapshot: "block text.Second",
        startOffset: 6
      })
    ]);
    const [defaulted] = noteHighlightDescriptors([
      note({
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        // endBlockEntryId omitted -> defaults to the start block.
        endOffset: 11,
        selectedTextSnapshot: "block",
        startOffset: 6
      } as AnchoredNoteDto["anchor"])
    ]);

    expect(crossBlock?.suffix).toBe("");
    expect(crossBlock?.endBlockEntryId).toBe("b2");
    expect(defaulted?.endBlockEntryId).toBe("b1");
  });
});

describe("applyNoteHighlights", () => {
  const twoBlocks =
    '<div data-block-id="b1">First block text.</div>' +
    '<div data-block-id="b2">Second block text.</div>';

  it("wraps the anchored text in an interactive underline naming the note it opens", () => {
    const container = reader(twoBlocks);

    const cleanup = applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })]);

    const [mark] = marks(container);
    expect(mark?.textContent).toBe("block");
    expect(mark?.className).toBe("noteMark noteMark--note");
    expect(mark?.getAttribute("data-note-id")).toBe("n1");
    expect(mark?.getAttribute("role")).toBe("button");
    expect(mark?.getAttribute("tabindex")).toBe("0");
    expect(mark?.getAttribute("aria-label")).toBe("Open note on 'block'");

    cleanup();
    expect(marks(container)).toHaveLength(0);
    expect(container.querySelector('[data-block-id="b1"]')?.textContent).toBe("First block text.");
  });

  it("names a bodyless mark's underline as a mark", () => {
    const container = reader(twoBlocks);

    applyNoteHighlights(container, [
      note(subBlockAnchor, {
        bodyDoc: null,
        bodyText: null,
        entryId: toEntryId("m1"),
        kind: "mark"
      })
    ]);

    const [mark] = marks(container);
    expect(mark?.className).toBe("noteMark noteMark--mark");
    expect(mark?.getAttribute("aria-label")).toBe("Open mark on 'block'");
  });

  it("reports the covering note id when an underline is clicked", () => {
    const container = reader(twoBlocks);
    const onActivate = vi.fn();

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    click(marks(container)[0] as HTMLElement);

    expect(onActivate).toHaveBeenCalledWith(["n1"]);
  });

  it("activates the underline from the keyboard and prevents Space from scrolling", () => {
    const container = reader(twoBlocks);
    const onActivate = vi.fn();

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    const [mark] = marks(container);

    const enter = keydown(mark as HTMLElement, "Enter");
    const space = keydown(mark as HTMLElement, " ");

    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(onActivate).toHaveBeenNthCalledWith(1, ["n1"]);
    expect(space.defaultPrevented).toBe(true);
    // Enter also activates (its default is not the scroll that Space is prevented for).
    expect(enter.type).toBe("keydown");
  });

  it("prevents default but does not swallow a keyboard activation on an id-less underline", () => {
    const container = reader(
      '<div data-block-id="b1">First block text.</div>' +
        '<p><span class="noteMark">x</span></p>'
    );
    const onActivate = vi.fn();
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    const enter = keydown(container.querySelector(".noteMark:not([data-note-id])") as HTMLElement, "Enter");

    expect(onActivate).not.toHaveBeenCalled();
    expect(enter.defaultPrevented).toBe(true);
    expect(bubbled).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", bubbled);
  });

  it("ignores keys other than Enter/Space and keys pressed off any underline", () => {
    const container = reader(twoBlocks);
    const onActivate = vi.fn();

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    const [mark] = marks(container);

    keydown(mark as HTMLElement, "a");
    keydown(container.querySelector('[data-block-id="b2"]') as HTMLElement, "Enter");

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("reports overlapping notes innermost-first and de-duplicates a repeated id", () => {
    const container = reader(
      '<div data-block-id="b1">First block text.</div>' +
        '<p><span class="noteMark" data-note-id="outer">' +
        '<span class="noteMark" data-note-id="inner">' +
        '<span class="noteMark" data-note-id="inner">x</span></span></span></p>'
    );
    const onActivate = vi.fn();

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    const innermost = container.querySelector('[data-note-id="inner"] [data-note-id="inner"]');
    click(innermost as HTMLElement);

    expect(onActivate).toHaveBeenCalledWith(["inner", "outer"]);
  });

  it("skips an enclosing element that is a noteMark without a note id", () => {
    const container = reader(
      '<div data-block-id="b1">First block text.</div>' +
        '<p><span class="noteMark" data-note-id="real">' +
        '<span class="noteMark">x</span></span></p>'
    );
    const onActivate = vi.fn();

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    click(container.querySelector(".noteMark .noteMark") as HTMLElement);

    expect(onActivate).toHaveBeenCalledWith(["real"]);
  });

  it("does not report or swallow a click that misses every underline", () => {
    const container = reader(twoBlocks);
    const onActivate = vi.fn();
    const bubbled = vi.fn();
    document.addEventListener("click", bubbled);

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    click(container.querySelector('[data-block-id="b2"]') as HTMLElement);

    expect(onActivate).not.toHaveBeenCalled();
    expect(bubbled).toHaveBeenCalledTimes(1);
    document.removeEventListener("click", bubbled);
  });

  it("ignores an activation whose target is a bare text node, not an element", () => {
    const container = reader(twoBlocks);
    const onActivate = vi.fn();
    const bubbled = vi.fn();
    document.addEventListener("click", bubbled);

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], onActivate);
    const textNode = (container.querySelector('[data-block-id="b2"]') as HTMLElement).firstChild as Text;
    textNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onActivate).not.toHaveBeenCalled();
    expect(bubbled).toHaveBeenCalledTimes(1);
    document.removeEventListener("click", bubbled);
  });

  it("stops a collapsed tap on an underline from reaching the reader's selection capture", () => {
    const container = reader(twoBlocks);
    const captured = vi.fn();
    document.addEventListener("mouseup", captured);
    document.addEventListener("touchend", captured);

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], vi.fn());
    const [mark] = marks(container);

    dispatch(mark as HTMLElement, new MouseEvent("mouseup", { bubbles: true }));
    dispatch(mark as HTMLElement, new Event("touchend", { bubbles: true }));

    expect(captured).not.toHaveBeenCalled();
    document.removeEventListener("mouseup", captured);
    document.removeEventListener("touchend", captured);
  });

  it("leaves a real drag that ends on an underline free to open capture", () => {
    const container = reader(twoBlocks);
    const captured = vi.fn();
    document.addEventListener("mouseup", captured);

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], vi.fn());
    const [mark] = marks(container);
    selectText(mark as Node);

    dispatch(mark as HTMLElement, new MouseEvent("mouseup", { bubbles: true }));

    expect(captured).toHaveBeenCalledTimes(1);
    document.removeEventListener("mouseup", captured);
  });

  it("ignores a release that lands off any underline", () => {
    const container = reader(twoBlocks);
    const captured = vi.fn();
    document.addEventListener("mouseup", captured);

    applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })], vi.fn());
    dispatch(
      container.querySelector('[data-block-id="b2"]') as HTMLElement,
      new MouseEvent("mouseup", { bubbles: true })
    );

    expect(captured).toHaveBeenCalledTimes(1);
    document.removeEventListener("mouseup", captured);
  });

  it("highlights a cross-block span: the start tail and the end head", () => {
    const container = reader(twoBlocks);

    applyNoteHighlights(container, [
      note(
        {
          blockEntryId: toEntryId("b1"),
          contextSnapshot: "First block text.",
          endBlockEntryId: toEntryId("b2"),
          endOffset: 6,
          selectedTextSnapshot: "block text.Second",
          startOffset: 6
        },
        { entryId: toEntryId("n2"), kind: "note" }
      )
    ]);

    const b1Mark = container.querySelector('[data-block-id="b1"] .noteMark');
    const b2Mark = container.querySelector('[data-block-id="b2"] .noteMark');
    expect(b1Mark?.textContent).toBe("block text.");
    expect(b2Mark?.textContent).toBe("Second");
  });

  it("re-anchors via the TextQuote snapshot when the block id no longer resolves", () => {
    const container = reader('<div data-block-id="b1">The clever different fox.</div>');

    applyNoteHighlights(container, [
      note(
        {
          blockEntryId: toEntryId("gone"),
          contextSnapshot: "different",
          endBlockEntryId: toEntryId("gone"),
          endOffset: 9,
          selectedTextSnapshot: "different",
          startOffset: 0
        },
        { entryId: toEntryId("n3") }
      )
    ]);

    const [mark] = marks(container);
    expect(mark?.textContent).toBe("different");
    expect(mark?.getAttribute("data-note-id")).toBe("n3");
  });

  it("re-anchors via TextQuote when the stored offsets fall outside the rendered block", () => {
    const container = reader('<div data-block-id="b1">A short edited line.</div>');

    applyNoteHighlights(container, [
      note({
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "edited",
        endBlockEntryId: toEntryId("b1"),
        endOffset: 106,
        selectedTextSnapshot: "edited",
        startOffset: 100
      })
    ]);

    expect(marks(container)[0]?.textContent).toBe("edited");
  });

  it("leaves nothing highlighted when the snapshot text is gone entirely", () => {
    const container = reader('<div data-block-id="b1">Nothing matches here.</div>');

    applyNoteHighlights(container, [
      note({
        blockEntryId: toEntryId("gone"),
        contextSnapshot: "absent",
        endBlockEntryId: toEntryId("gone"),
        endOffset: 6,
        selectedTextSnapshot: "absent",
        startOffset: 0
      })
    ]);

    expect(marks(container)).toHaveLength(0);
  });

  it("highlights only the offset notes and skips whole-block notes in the same set", () => {
    const container = reader(twoBlocks);

    applyNoteHighlights(container, [
      note({
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        selectedTextSnapshot: "First block text."
      }),
      note(
        {
          blockEntryId: toEntryId("b2"),
          contextSnapshot: "Second block text.",
          endBlockEntryId: toEntryId("b2"),
          endOffset: 12,
          selectedTextSnapshot: "block",
          startOffset: 7
        },
        { entryId: toEntryId("n4") }
      )
    ]);

    const all = marks(container);
    expect(all).toHaveLength(1);
    expect(all[0]?.textContent).toBe("block");
  });

  it("returns a no-op cleanup and wires no activation when every note is whole-block", () => {
    const container = reader(twoBlocks);
    const onActivate = vi.fn();

    const cleanup = applyNoteHighlights(
      container,
      [
        note({
          blockEntryId: toEntryId("b1"),
          contextSnapshot: "First block text.",
          endBlockEntryId: toEntryId("b1"),
          selectedTextSnapshot: "First block text."
        })
      ],
      onActivate
    );

    expect(marks(container)).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });

  it("wires no activation when no handler is supplied", () => {
    const container = reader(twoBlocks);
    const captured = vi.fn();
    document.addEventListener("mouseup", captured);

    const cleanup = applyNoteHighlights(container, [note(subBlockAnchor, { entryId: toEntryId("n1") })]);
    // With no handler there is no delegated listener, so a tap on the underline is left untouched.
    dispatch(marks(container)[0] as HTMLElement, new MouseEvent("mouseup", { bubbles: true }));

    expect(captured).toHaveBeenCalledTimes(1);
    expect(() => cleanup()).not.toThrow();
    document.removeEventListener("mouseup", captured);
  });
});
