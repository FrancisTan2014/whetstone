import type { DocumentNodeJSON } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import { normalizeManualWorkDocument } from "./manualWorkDocument.js";

function paragraph(text: string): DocumentNodeJSON {
  return { content: [{ text, type: "text" }], type: "paragraph" };
}

const emptyParagraph: DocumentNodeJSON = { type: "paragraph" };

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
