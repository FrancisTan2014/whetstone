// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { NoteDto } from "@whetstone/contracts";
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

function note(anchor: NoteDto["anchor"], overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    answers: {},
    blockEntryId: anchor.blockEntryId,
    entryId: toEntryId("note-1"),
    markdown: "",
    templateId: "vocabulary",
    ...overrides,
    anchor
  };
}

function marks(container: Element): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".noteMark"));
}

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
    const [descriptor] = noteHighlightDescriptors([
      note({
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        endOffset: 11,
        selectedTextSnapshot: "block",
        startOffset: 6
      })
    ]);

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
      } as NoteDto["anchor"])
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

  it("wraps exactly the anchored text in an interactive highlight span (block-id + offset)", async () => {
    const container = reader(twoBlocks);

    const cleanup = await applyNoteHighlights(container, [
      note(
        {
          blockEntryId: toEntryId("b1"),
          contextSnapshot: "First block text.",
          endOffset: 11,
          selectedTextSnapshot: "block",
          startOffset: 6
        } as NoteDto["anchor"],
        { entryId: toEntryId("n1") }
      )
    ]);

    const [mark] = marks(container);
    expect(mark?.textContent).toBe("block");
    expect(mark?.getAttribute("data-note-id")).toBe("n1");
    expect(mark?.getAttribute("aria-label")).toBe("Note on 'block'");
    expect(mark?.getAttribute("role")).toBe("button");
    expect(mark?.getAttribute("tabindex")).toBe("0");

    cleanup();
    expect(marks(container)).toHaveLength(0);
    expect(container.querySelector('[data-block-id="b1"]')?.textContent).toBe("First block text.");
  });

  it("highlights a cross-block span: the start tail and the end head", async () => {
    const container = reader(twoBlocks);

    await applyNoteHighlights(container, [
      note(
        {
          blockEntryId: toEntryId("b1"),
          contextSnapshot: "First block text.",
          endBlockEntryId: toEntryId("b2"),
          endOffset: 6,
          selectedTextSnapshot: "block text.Second",
          startOffset: 6
        },
        { entryId: toEntryId("n2"), templateId: null }
      )
    ]);

    const b1Mark = container.querySelector('[data-block-id="b1"] .noteMark');
    const b2Mark = container.querySelector('[data-block-id="b2"] .noteMark');
    expect(b1Mark?.textContent).toBe("block text.");
    expect(b2Mark?.textContent).toBe("Second");
  });

  it("re-anchors via the TextQuote snapshot when the block id no longer resolves", async () => {
    const container = reader('<div data-block-id="b1">The clever different fox.</div>');

    await applyNoteHighlights(container, [
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

  it("re-anchors via TextQuote when the stored offsets fall outside the rendered block", async () => {
    const container = reader('<div data-block-id="b1">A short edited line.</div>');

    await applyNoteHighlights(container, [
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

  it("leaves nothing highlighted when the snapshot text is gone entirely", async () => {
    const container = reader('<div data-block-id="b1">Nothing matches here.</div>');

    await applyNoteHighlights(container, [
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

  it("highlights only the offset notes and skips whole-block notes in the same set", async () => {
    const container = reader(twoBlocks);

    await applyNoteHighlights(container, [
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

  it("returns a no-op cleanup and adds nothing when every note is whole-block", async () => {
    const container = reader(twoBlocks);

    const cleanup = await applyNoteHighlights(container, [
      note({
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        selectedTextSnapshot: "First block text."
      })
    ]);

    expect(marks(container)).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });
});
