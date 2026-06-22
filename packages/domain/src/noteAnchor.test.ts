import { describe, expect, it } from "vitest";

import { createNoteAnchor, toEntryId, type CreateNoteAnchorInput } from "./index.js";

const readingUnitEntryId = toEntryId("reading-unit-1");

function validAnchor(overrides: Partial<CreateNoteAnchorInput> = {}): CreateNoteAnchorInput {
  return {
    contextSnapshot: "The quick brown fox jumps over the lazy dog.",
    endOffset: 19,
    readingUnitEntryId,
    selectedTextSnapshot: "brown fox",
    startOffset: 10,
    ...overrides
  };
}

describe("createNoteAnchor", () => {
  it("creates immutable anchors for selected reader text", () => {
    const anchor = createNoteAnchor(validAnchor());

    expect(anchor).toEqual({
      contextSnapshot: "The quick brown fox jumps over the lazy dog.",
      endOffset: 19,
      readingUnitEntryId,
      selectedTextSnapshot: "brown fox",
      startOffset: 10
    });
    expect(Object.isFrozen(anchor)).toBe(true);
  });

  it("rejects non-integer offsets", () => {
    expect(() => createNoteAnchor(validAnchor({ startOffset: 10.5 }))).toThrow(
      "NoteAnchor startOffset must be an integer."
    );
  });

  it("rejects negative offsets", () => {
    expect(() => createNoteAnchor(validAnchor({ endOffset: -1 }))).toThrow(
      "NoteAnchor endOffset must be non-negative."
    );
  });

  it("rejects ranges whose end does not follow the start", () => {
    expect(() => createNoteAnchor(validAnchor({ endOffset: 10 }))).toThrow(
      "NoteAnchor endOffset must be greater than startOffset."
    );
  });

  it("rejects empty selected text snapshots", () => {
    expect(() => createNoteAnchor(validAnchor({ selectedTextSnapshot: " " }))).toThrow(
      "NoteAnchor selectedTextSnapshot must be non-empty."
    );
  });

  it("rejects empty context snapshots", () => {
    expect(() => createNoteAnchor(validAnchor({ contextSnapshot: " " }))).toThrow(
      "NoteAnchor contextSnapshot must be non-empty."
    );
  });

  it("rejects context snapshots that do not preserve the selected text", () => {
    expect(() =>
      createNoteAnchor(validAnchor({ contextSnapshot: "No matching text here." }))
    ).toThrow("NoteAnchor contextSnapshot must contain selectedTextSnapshot.");
  });
});
