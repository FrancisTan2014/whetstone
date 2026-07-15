// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import { blockOpenerAction, blockOpenerLabel } from "./blockAnnotationOpener";

function note(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return {
    anchor: {
      blockEntryId: toEntryId("b1"),
      contextSnapshot: "First block text.",
      endBlockEntryId: toEntryId("b1"),
      endOffset: 11,
      selectedTextSnapshot: "block",
      startOffset: 6
    },
    blockEntryId: toEntryId("b1"),
    bodyDoc: createTextDocument("a note"),
    bodyText: "a note",
    captureSource: "reader",
    createdAt: "2024-01-01T00:00:00.000Z",
    entryId: toEntryId("note-1"),
    kind: "note",
    occurredAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides
  };
}

function mark(overrides: Partial<AnchoredNoteDto> = {}): AnchoredNoteDto {
  return note({
    bodyDoc: null,
    bodyText: null,
    entryId: toEntryId("mark-1"),
    kind: "mark",
    ...overrides
  });
}

describe("blockOpenerLabel", () => {
  it("names the kind and anchored text for a single rich note", () => {
    expect(blockOpenerLabel([note()])).toBe("Open note on 'block'");
  });

  it("names a single bodyless mark as a mark", () => {
    expect(blockOpenerLabel([mark()])).toBe("Open mark on 'block'");
  });

  it("announces the count for a passage with more than one annotation", () => {
    expect(blockOpenerLabel([note(), mark()])).toBe("Open 2 annotations in this passage");
  });
});

describe("blockOpenerAction", () => {
  it("opens the note editor directly for a single rich note", () => {
    const only = note();

    expect(blockOpenerAction([only])).toEqual({ kind: "note", note: only });
  });

  it("opens the chooser for a single bodyless mark", () => {
    expect(blockOpenerAction([mark()])).toEqual({ kind: "chooser" });
  });

  it("opens the chooser for more than one annotation", () => {
    expect(blockOpenerAction([note(), mark()])).toEqual({ kind: "chooser" });
  });

  it("opens a whole-block single note (no sub-block offsets) directly, not the chooser", () => {
    const wholeBlock = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        selectedTextSnapshot: "First block text."
      }
    });

    expect(blockOpenerLabel([wholeBlock])).toBe("Open note on 'First block text.'");
    expect(blockOpenerAction([wholeBlock])).toEqual({ kind: "note", note: wholeBlock });
  });
});
