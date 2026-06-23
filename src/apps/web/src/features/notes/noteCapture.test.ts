import { describe, expect, it } from "vitest";

import { captureBlockSelection } from "./noteCapture";

const blockText = "The quick brown fox jumps over the lazy dog.";

describe("captureBlockSelection", () => {
  it("captures a sub-block phrase with an offset range and template preselection", () => {
    expect(captureBlockSelection("block-1", blockText, "brown fox")).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: blockText,
      endOffset: 19,
      preselectedTemplateId: "expression",
      selectedText: "brown fox",
      startOffset: 10
    });
  });

  it("preselects Vocabulary for a single selected word", () => {
    const draft = captureBlockSelection("block-1", blockText, "fox");

    expect(draft?.preselectedTemplateId).toBe("vocabulary");
    expect(draft?.startOffset).toBe(16);
  });

  it("captures a whole-block selection without offsets", () => {
    const draft = captureBlockSelection("block-1", blockText, blockText);

    expect(draft).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: blockText,
      preselectedTemplateId: "thought",
      selectedText: blockText
    });
    expect(draft?.startOffset).toBeUndefined();
  });

  it("ignores an empty selection", () => {
    expect(captureBlockSelection("block-1", blockText, "   ")).toBeUndefined();
  });

  it("ignores a selection that is not contained in the block", () => {
    expect(captureBlockSelection("block-1", blockText, "absent")).toBeUndefined();
  });
});
