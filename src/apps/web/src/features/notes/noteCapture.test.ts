import { describe, expect, it } from "vitest";

import { captureBlockSelection, captureCrossBlockSelection, draftToAnchor } from "./noteCapture";

const blockText = "The quick brown fox jumps over the lazy dog.";

describe("captureBlockSelection", () => {
  it("captures a sub-block phrase with an offset range and template preselection", () => {
    expect(captureBlockSelection("block-1", blockText, "The quick ", "brown fox")).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: blockText,
      endOffset: 19,
      preselectedTemplateId: "expression",
      selectedText: "brown fox",
      startOffset: 10
    });
  });

  it("preselects Vocabulary for a single selected word", () => {
    const draft = captureBlockSelection("block-1", blockText, "The quick brown ", "fox");

    expect(draft?.preselectedTemplateId).toBe("vocabulary");
    expect(draft?.startOffset).toBe(16);
    expect(draft?.endOffset).toBe(19);
  });

  it("anchors repeated text to the selected occurrence, not the first match", () => {
    const repeated = "the cat sat on the mat";

    expect(captureBlockSelection("block-1", repeated, "", "the")).toMatchObject({
      endOffset: 3,
      startOffset: 0
    });
    expect(captureBlockSelection("block-1", repeated, "the cat sat on ", "the")).toMatchObject({
      endOffset: 18,
      startOffset: 15
    });
  });

  it("captures a whole-block selection without offsets", () => {
    const draft = captureBlockSelection("block-1", blockText, "", blockText);

    expect(draft).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: blockText,
      preselectedTemplateId: "thought",
      selectedText: blockText
    });
    expect(draft?.startOffset).toBeUndefined();
  });

  it("aligns a blockquote selection past the rendered DOM's leading whitespace", () => {
    // The rendered blockquote DOM is "\nHello world from a quote.\n"; the plaintext omits the
    // structural newlines, so the preceding text carries a leading "\n" the plaintext lacks.
    const quote = "Hello world from a quote.";

    expect(captureBlockSelection("block-1", quote, "\n", "Hello")).toMatchObject({
      endOffset: 5,
      selectedText: "Hello",
      startOffset: 0
    });
  });

  it("aligns a list selection across the rendered DOM's inter-item whitespace", () => {
    // The rendered list DOM is "\nitem one\nitem two\n" while the mdast plaintext concatenates
    // the items as "item oneitem two"; non-whitespace alignment still locates "item two".
    const list = "item oneitem two";

    expect(captureBlockSelection("block-1", list, "\nitem one\n", "item two")).toEqual({
      blockEntryId: "block-1",
      contextSnapshot: list,
      endOffset: 16,
      preselectedTemplateId: "expression",
      selectedText: "item two",
      startOffset: 8
    });
  });

  it("ignores an empty or whitespace-only selection", () => {
    expect(captureBlockSelection("block-1", blockText, "", "   ")).toBeUndefined();
  });

  it("ignores a selection that runs past the end of the block", () => {
    expect(captureBlockSelection("block-1", "short", "short text beyond", "more")).toBeUndefined();
  });

  it("ignores a selection longer than the block text remaining after its start", () => {
    expect(captureBlockSelection("block-1", "abc", "a", "bcde")).toBeUndefined();
  });

  it("ignores a selection whose text does not match the block at that position", () => {
    expect(captureBlockSelection("block-1", blockText, "", "absent")).toBeUndefined();
  });
});

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

describe("captureCrossBlockSelection", () => {
  const startText = "The quick brown fox.";
  const endText = "Jumps over the lazy dog.";

  it("aligns each end block's portion and joins the selected text (#257)", () => {
    const draft = captureCrossBlockSelection(
      "b1",
      startText,
      "The quick ",
      "brown fox.",
      "b2",
      endText,
      "Jumps over",
      "brown fox. Jumps over"
    );

    expect(draft).toMatchObject({
      blockEntryId: "b1",
      contextSnapshot: startText,
      endBlockEntryId: "b2",
      endOffset: 10,
      selectedText: "brown fox. Jumps over",
      startOffset: 10
    });
  });

  it("falls back to whole-block bounds when each end is fully selected (#257)", () => {
    const draft = captureCrossBlockSelection(
      "b1",
      startText,
      "",
      startText,
      "b2",
      endText,
      endText,
      `${startText} ${endText}`
    );

    // The start block is selected whole (offset 0); the end block whole (offset = its length).
    expect(draft?.startOffset).toBe(0);
    expect(draft?.endOffset).toBe(endText.length);
  });

  it("returns undefined when a portion does not line up with its block (#257)", () => {
    expect(
      captureCrossBlockSelection("b1", startText, "", "absent", "b2", endText, "Jumps", "x")
    ).toBeUndefined();
  });
});
