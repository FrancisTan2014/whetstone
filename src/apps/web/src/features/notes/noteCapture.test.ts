import { describe, expect, it } from "vitest";

import { captureBlockSelection } from "./noteCapture";

const blockText = "The quick brown fox jumps over the lazy dog.";

describe("captureBlockSelection", () => {
  it("captures a sub-block phrase with an offset range and template preselection", () => {
    expect(captureBlockSelection("block-1", blockText, "brown fox", 10)).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: blockText,
      endOffset: 19,
      preselectedTemplateId: "expression",
      selectedText: "brown fox",
      startOffset: 10
    });
  });

  it("preselects Vocabulary for a single selected word", () => {
    const draft = captureBlockSelection("block-1", blockText, "fox", 16);

    expect(draft?.preselectedTemplateId).toBe("vocabulary");
    expect(draft?.startOffset).toBe(16);
  });

  it("anchors repeated text to the selected occurrence, not the first match", () => {
    const repeated = "the cat sat on the mat";

    expect(captureBlockSelection("block-1", repeated, "the", 0)).toMatchObject({
      endOffset: 3,
      startOffset: 0
    });
    expect(captureBlockSelection("block-1", repeated, "the", 15)).toMatchObject({
      endOffset: 18,
      startOffset: 15
    });
  });

  it("captures a whole-block selection without offsets", () => {
    const draft = captureBlockSelection("block-1", blockText, blockText, 0);

    expect(draft).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: blockText,
      preselectedTemplateId: "thought",
      selectedText: blockText
    });
    expect(draft?.startOffset).toBeUndefined();
  });

  it("ignores an empty selection", () => {
    expect(captureBlockSelection("block-1", blockText, "   ", 0)).toBeUndefined();
  });

  it("ignores a negative offset", () => {
    expect(captureBlockSelection("block-1", blockText, "The", -1)).toBeUndefined();
  });

  it("ignores a selection whose text does not match the block at that offset", () => {
    expect(captureBlockSelection("block-1", blockText, "absent", 0)).toBeUndefined();
  });
});
