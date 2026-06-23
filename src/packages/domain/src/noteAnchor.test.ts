import { describe, expect, it } from "vitest";

import { createNoteAnchor, toEntryId, type CreateNoteAnchorInput } from "./index.js";

const blockEntryId = toEntryId("block-1");

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
      endOffset: 19,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });
    expect(Object.isFrozen(anchor)).toBe(true);
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
});
