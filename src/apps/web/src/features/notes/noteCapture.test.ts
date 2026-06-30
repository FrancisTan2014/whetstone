import { describe, expect, it } from "vitest";

import { draftToAnchor } from "./noteCapture";

describe("draftToAnchor", () => {
  it("defaults the end block to the start block for a single-block draft", () => {
    const anchor = draftToAnchor({
      blockEntryId: "b1",
      contextSnapshot: "ctx",
      endOffset: 5,
      preselectedTemplateId: "vocabulary",
      selectedText: "ctx",
      startOffset: 0
    });

    expect(anchor.endBlockEntryId).toBe("b1");
    expect(anchor.startOffset).toBe(0);
    expect(anchor.endOffset).toBe(5);
  });

  it("omits the offsets for a whole-block draft", () => {
    const anchor = draftToAnchor({
      blockEntryId: "b1",
      contextSnapshot: "ctx",
      preselectedTemplateId: "thought",
      selectedText: "ctx"
    });

    expect(anchor.startOffset).toBeUndefined();
    expect(anchor.endOffset).toBeUndefined();
    expect(anchor.endBlockEntryId).toBe("b1");
  });

  it("keeps a distinct end block and both offsets for a cross-block draft", () => {
    const anchor = draftToAnchor({
      blockEntryId: "b1",
      contextSnapshot: "ctx",
      endBlockEntryId: "b2",
      endOffset: 4,
      preselectedTemplateId: "expression",
      selectedText: "spanned",
      startOffset: 10
    });

    expect(anchor.blockEntryId).toBe("b1");
    expect(anchor.endBlockEntryId).toBe("b2");
    expect(anchor.startOffset).toBe(10);
    expect(anchor.endOffset).toBe(4);
  });
});
