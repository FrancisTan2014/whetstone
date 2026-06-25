import { describe, expect, it } from "vitest";

import { captureBlockSelection } from "./noteCapture";

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
