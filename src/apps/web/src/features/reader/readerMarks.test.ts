import { describe, expect, it } from "vitest";

import type { NoteDto } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import type { NoteDraft } from "../notes/noteCapture";
import type { ReaderBlock } from "./readerModel";
import { draftOverlapsNotes, indexBlocks, spanMarksForBlock } from "./readerMarks";

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

describe("spanMarksForBlock", () => {
  it("marks a single-block sub-range only on its block", () => {
    const single = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        endOffset: 11,
        selectedTextSnapshot: "block",
        startOffset: 6
      },
      entryId: toEntryId("n1")
    });

    expect(spanMarksForBlock("b1", [single], index)).toEqual([
      {
        ariaLabel: "Note on 'block'",
        className: "noteMark--vocab",
        endOffset: 11,
        noteId: "n1",
        startOffset: 6
      }
    ]);
    expect(spanMarksForBlock("b2", [single], index)).toEqual([]);
  });

  it("marks a cross-block span on each intersected block", () => {
    const span = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b2"),
        endOffset: 6,
        selectedTextSnapshot: "block text.Second",
        startOffset: 6
      },
      entryId: toEntryId("n2"),
      templateId: null
    });

    expect(spanMarksForBlock("b1", [span], index)).toEqual([
      expect.objectContaining({ endOffset: 17, noteId: "n2", startOffset: 6 })
    ]);
    expect(spanMarksForBlock("b2", [span], index)).toEqual([
      expect.objectContaining({
        className: "noteMark--gem",
        endOffset: 6,
        noteId: "n2",
        startOffset: 0
      })
    ]);
  });

  it("excludes a whole-block note (no offsets) from the underline marks", () => {
    const whole = note({
      anchor: {
        blockEntryId: toEntryId("b1"),
        contextSnapshot: "First block text.",
        endBlockEntryId: toEntryId("b1"),
        selectedTextSnapshot: "First block text."
      }
    });

    expect(spanMarksForBlock("b1", [whole], index)).toEqual([]);
  });
});

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
