import type { DocumentNodeJSON } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import { ensureHeadingLedSection, normalizeManualWorkDocument } from "./manualWorkDocument.js";

function paragraph(text: string): DocumentNodeJSON {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

const emptyParagraph: DocumentNodeJSON = { type: "paragraph" };

function heading(level: number, text: string): DocumentNodeJSON {
  return { attrs: { level }, content: [{ text, type: "text" }], type: "heading" };
}

describe("normalizeManualWorkDocument", () => {
  it("trims a run of trailing empty paragraphs", () => {
    const result = normalizeManualWorkDocument({
      content: [paragraph("Body"), emptyParagraph, emptyParagraph],
      type: "doc"
    });

    expect(result).toEqual({ content: [paragraph("Body")], type: "doc" });
  });

  it("preserves an empty paragraph that sits between content blocks", () => {
    const content = [paragraph("First"), emptyParagraph, paragraph("Second")];

    const result = normalizeManualWorkDocument({ content, type: "doc" });

    expect(result).toEqual({ content, type: "doc" });
  });

  it("floors an all-empty document to a single empty paragraph", () => {
    const result = normalizeManualWorkDocument({
      content: [emptyParagraph, emptyParagraph],
      type: "doc"
    });

    expect(result).toEqual({ content: [emptyParagraph], type: "doc" });
  });

  it("floors a document with no content to a single empty paragraph", () => {
    const result = normalizeManualWorkDocument({ type: "doc" });

    expect(result).toEqual({ content: [emptyParagraph], type: "doc" });
  });

  it("keeps a document that already ends in content unchanged", () => {
    const content = [paragraph("Only line")];

    const result = normalizeManualWorkDocument({ content, type: "doc" });

    expect(result).toEqual({ content, type: "doc" });
  });
});

describe("ensureHeadingLedSection", () => {
  it("leaves a document already led by a heading unchanged", () => {
    const document: DocumentNodeJSON = {
      content: [heading(2, "Chapter"), paragraph("Body")],
      type: "doc"
    };

    expect(ensureHeadingLedSection(document)).toBe(document);
  });

  it("leaves a document with no content array unchanged", () => {
    const document: DocumentNodeJSON = { type: "doc" };

    expect(ensureHeadingLedSection(document)).toBe(document);
  });

  it("remaps a leading paragraph into a heading, preserving its inline content, id, and later blocks", () => {
    const first: DocumentNodeJSON = {
      attrs: { id: "block-1" },
      content: [{ marks: [{ type: "bold" }], text: "Section Two", type: "text" }],
      type: "paragraph"
    };

    const result = ensureHeadingLedSection({ content: [first, paragraph("Body")], type: "doc" });

    expect(result).toEqual({
      content: [
        {
          attrs: { id: "block-1", level: 1 },
          content: [{ marks: [{ type: "bold" }], text: "Section Two", type: "text" }],
          type: "heading"
        },
        paragraph("Body")
      ],
      type: "doc"
    });
  });

  it("seeds a heading from the plaintext of a non-paragraph leading block", () => {
    const list: DocumentNodeJSON = {
      content: [
        { content: [paragraph("First bullet")], type: "listItem" },
        { content: [paragraph("Second bullet")], type: "listItem" }
      ],
      type: "bulletList"
    };

    const result = ensureHeadingLedSection({ content: [list, paragraph("Body")], type: "doc" });

    expect(result).toEqual({
      content: [
        {
          attrs: { level: 1 },
          content: [{ text: "First bulletSecond bullet", type: "text" }],
          type: "heading"
        },
        paragraph("Body")
      ],
      type: "doc"
    });
  });

  it("seeds an untitled heading from a textless leading block", () => {
    const result = ensureHeadingLedSection({ content: [{ type: "horizontalRule" }], type: "doc" });

    expect(result).toEqual({ content: [{ attrs: { level: 1 }, type: "heading" }], type: "doc" });
  });
});
