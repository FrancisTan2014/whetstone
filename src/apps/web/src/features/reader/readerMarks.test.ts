import { describe, expect, it } from "vitest";

import type { NoteDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import type { NoteDraft } from "../notes/noteCapture";
import type { ReaderBlock } from "./readerModel";
import { draftOverlapsNotes, indexBlocks } from "./readerMarks";

function block(entryId: string, plaintext: string): ReaderBlock {
  return { blockType: "paragraph", entryId, isHeading: false, mdast: {}, plaintext };
}

function note(overrides: Partial<NoteDto> & { anchor: NoteDto["anchor"] }): NoteDto {
  return {
    answers: {},
    blockEntryId: overrides.anchor.blockEntryId,
    entryId: toEntryId("note-1"),
    markdown: "",
    templateId: "vocabulary",
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
    preselectedTemplateId: "vocabulary",
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
      preselectedTemplateId: "thought",
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
      preselectedTemplateId: "thought",
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
