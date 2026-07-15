import { describe, expect, it } from "vitest";

import type { AnchoredNoteDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import type { NoteDraft } from "../notes/noteCapture";
import type { ReaderBlock } from "./readerModel";
import { draftOverlapsNotes, indexBlocks } from "./readerMarks";

function block(entryId: string, plaintext: string): ReaderBlock {
  return { blockType: "paragraph", entryId, isHeading: false, mdast: {}, plaintext };
}

function note(
  overrides: Partial<AnchoredNoteDto> & { anchor: AnchoredNoteDto["anchor"] }
): AnchoredNoteDto {
  return {
    blockEntryId: overrides.anchor.blockEntryId,
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

const blocks = [block("b1", "First block text."), block("b2", "Second block text.")];
const index = indexBlocks(blocks);

describe("draftOverlapsNotes", () => {
  const subBlockDraft: NoteDraft = {
    blockEntryId: "b1",
    contextSnapshot: "First block text.",
    endOffset: 11,
    selectedText: "block",
    startOffset: 6
  };

  it("is false when no note shares a covered character", () => {
    const other = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        endOffset: 5,
        selectedTextSnapshot: "First",
        startOffset: 0
      }
    });

    expect(draftOverlapsNotes(subBlockDraft, [other], index)).toBe(false);
  });

  it("is true when a whole-block note covers the draft's block", () => {
    const whole = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        selectedTextSnapshot: "First block text."
      }
    });

    expect(draftOverlapsNotes(subBlockDraft, [whole], index)).toBe(true);
  });

  it("treats a whole-block draft as covering its whole block", () => {
    const wholeDraft: NoteDraft = {
      blockEntryId: "b1",
      contextSnapshot: "First block text.",
      selectedText: "First block text."
    };
    const sub = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        endOffset: 11,
        selectedTextSnapshot: "block",
        startOffset: 6
      }
    });

    expect(draftOverlapsNotes(wholeDraft, [sub], index)).toBe(true);
  });

  it("yields no ranges (no overlap) when the draft's block is absent from the unit", () => {
    const wholeDraft: NoteDraft = {
      blockEntryId: "gone",
      contextSnapshot: "x",
      selectedText: "x"
    };
    const whole = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        selectedTextSnapshot: "First block text."
      }
    });

    // The draft's block is unknown to the index, so it produces no ranges and cannot overlap.
    expect(draftOverlapsNotes(wholeDraft, [whole], index)).toBe(false);
  });
});
