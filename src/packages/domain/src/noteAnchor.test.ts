import { describe, expect, it } from "vitest";

import { createNoteAnchor, toEntryId, type CreateNoteAnchorInput } from "./index.js";

const blockEntryId = toEntryId("block-1");
const endBlockEntryId = toEntryId("block-2");

function crossBlockAnchor(overrides: Partial<CreateNoteAnchorInput> = {}): CreateNoteAnchorInput {
  return {
    blockEntryId,
    contextSnapshot: "The quick brown fox.",
    endBlockEntryId,
    endOffset: 4,
    selectedTextSnapshot: "fox … the cat",
    startOffset: 10,
    ...overrides
  };
}

function subBlockAnchor(overrides: Partial<CreateNoteAnchorInput> = {}): CreateNoteAnchorInput {
  return {
    blockEntryId,
    contextSnapshot: "The quick brown fox jumps over the lazy dog.",
    endOffset: 19,
    selectedTextSnapshot: "brown fox",
    startOffset: 10,
    ...overrides
  };
}

describe("createNoteAnchor", () => {
  it("creates an immutable sub-block anchor with a character offset range", () => {
    const anchor = createNoteAnchor(subBlockAnchor());

    expect(anchor).toEqual({
      blockEntryId,
      contextSnapshot: "The quick brown fox jumps over the lazy dog.",
      endBlockEntryId: blockEntryId,
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });
    expect(Object.isFrozen(anchor)).toBe(true);
  });

  it("accepts a valid range that starts at offset 0", () => {
    // Pins the valid-zero boundary so a `< 0` -> `<= 0` mutation (which would reject a legitimate
    // selection at the very start of a block) fails a test.
    const anchor = createNoteAnchor(
      subBlockAnchor({ endOffset: 9, selectedTextSnapshot: "The quick", startOffset: 0 })
    );

    expect(anchor.startOffset).toBe(0);
    expect(anchor.endOffset).toBe(9);
  });

  it("creates a whole-block anchor without offsets", () => {
    const anchor = createNoteAnchor({
      blockEntryId,
      contextSnapshot: "brown fox",
      selectedTextSnapshot: "brown fox"
    });

    expect(anchor).toEqual({
      blockEntryId,
      contextSnapshot: "brown fox",
      endBlockEntryId: blockEntryId,
      selectedTextSnapshot: "brown fox"
    });
    expect("startOffset" in anchor).toBe(false);
  });

  it("rejects an offset range that is not provided as a pair", () => {
    expect(() => createNoteAnchor(subBlockAnchor({ endOffset: undefined }))).toThrow(
      "NoteAnchor startOffset and endOffset must be provided together."
    );
  });

  it("rejects non-integer offsets", () => {
    expect(() => createNoteAnchor(subBlockAnchor({ startOffset: 10.5 }))).toThrow(
      "NoteAnchor startOffset must be an integer."
    );
  });

  it("rejects negative offsets", () => {
    expect(() => createNoteAnchor(subBlockAnchor({ endOffset: -1, startOffset: -2 }))).toThrow(
      "NoteAnchor startOffset must be non-negative."
    );
  });

  it("rejects ranges whose end does not follow the start", () => {
    expect(() => createNoteAnchor(subBlockAnchor({ endOffset: 10 }))).toThrow(
      "NoteAnchor endOffset must be greater than startOffset."
    );
  });

  it("rejects empty selected text snapshots", () => {
    expect(() => createNoteAnchor(subBlockAnchor({ selectedTextSnapshot: " " }))).toThrow(
      "NoteAnchor selectedTextSnapshot must be non-empty."
    );
  });

  it("rejects empty context snapshots", () => {
    expect(() => createNoteAnchor(subBlockAnchor({ contextSnapshot: " " }))).toThrow(
      "NoteAnchor contextSnapshot must be non-empty."
    );
  });

  it("rejects context snapshots that do not preserve the selected text", () => {
    expect(() =>
      createNoteAnchor(subBlockAnchor({ contextSnapshot: "No matching text here." }))
    ).toThrow("NoteAnchor contextSnapshot must contain selectedTextSnapshot.");
  });

  it("creates an immutable cross-block span with an offset on each end block (#257)", () => {
    const anchor = createNoteAnchor(crossBlockAnchor());

    expect(anchor).toEqual({
      blockEntryId,
      contextSnapshot: "The quick brown fox.",
      endBlockEntryId,
      endOffset: 4,
      selectedTextSnapshot: "fox … the cat",
      startOffset: 10
    });
    expect(Object.isFrozen(anchor)).toBe(true);
  });

  it("allows a cross-block end offset that is not greater than the start offset (#257)", () => {
    // The offsets index different blocks, so the same-block endOffset > startOffset rule does not
    // apply; nor does the context-contains-selected-text rule across blocks.
    const anchor = createNoteAnchor(
      crossBlockAnchor({ contextSnapshot: "unrelated context", endOffset: 3, startOffset: 10 })
    );

    expect(anchor.endBlockEntryId).toBe(endBlockEntryId);
    expect(anchor.endOffset).toBe(3);
    expect(anchor.startOffset).toBe(10);
  });

  it("rejects a cross-block span missing an offset (#257)", () => {
    expect(() => createNoteAnchor(crossBlockAnchor({ endOffset: undefined }))).toThrow(
      "NoteAnchor cross-block span must provide startOffset and endOffset."
    );
  });

  it("rejects a cross-block span with a negative offset (#257)", () => {
    expect(() => createNoteAnchor(crossBlockAnchor({ startOffset: -1 }))).toThrow(
      "NoteAnchor startOffset must be non-negative."
    );
  });
});
