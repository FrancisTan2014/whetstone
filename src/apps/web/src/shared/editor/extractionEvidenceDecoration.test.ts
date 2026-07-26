// @vitest-environment jsdom
import { Editor, type Extensions } from "@tiptap/core";
import { type DocumentNodeJSON, documentExtensions } from "@whetstone/document";
import type { PdfExtractionEvidenceItemDto } from "@whetstone/contracts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  ExtractionEvidenceDecoration,
  extractionEvidenceKey,
  setExtractionEvidence,
  type ExtractionEvidenceMap
} from "./extractionEvidenceDecoration";
import { extractionEvidenceCueClass } from "./extractionEvidence.tokens";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => [] as unknown as DOMRectList
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect()
  });
});

const extensions: Extensions = [
  ...(documentExtensions as unknown as Extensions),
  ExtractionEvidenceDecoration as unknown as Extensions[number]
];

let editors: Editor[] = [];

function makeEditor(content: DocumentNodeJSON): Editor {
  const element = document.createElement("div");
  document.body.append(element);
  const editor = new Editor({ content, element, extensions });
  editors.push(editor);
  return editor;
}

// Paragraphs carrying explicit stable ids, so evidence can be keyed by them (UniqueID keeps existing ids).
function paragraphs(...ids: string[]): DocumentNodeJSON {
  return {
    content: ids.map((id) => ({
      attrs: { id },
      content: [{ text: id, type: "text" }],
      type: "paragraph"
    })),
    type: "doc"
  };
}

function evidenceItem(
  overrides: Partial<PdfExtractionEvidenceItemDto> & { blockId: string }
): PdfExtractionEvidenceItemDto {
  return {
    confidence: 0.4,
    corrected: false,
    label: "text",
    ocrEngine: null,
    ocrLanguage: null,
    page: 1,
    reviewSuggested: true,
    ...overrides
  };
}

function evidenceMap(...items: PdfExtractionEvidenceItemDto[]): ExtractionEvidenceMap {
  return new Map(items.map((item) => [item.blockId, item]));
}

function cuedTexts(editor: Editor): string[] {
  return Array.from(editor.view.dom.querySelectorAll(`.${extractionEvidenceCueClass}`)).map(
    (node) => node.textContent ?? ""
  );
}

afterEach(() => {
  for (const editor of editors) {
    editor.destroy();
  }
  editors = [];
});

describe("ExtractionEvidenceDecoration", () => {
  it("adds no cue while the evidence map is empty (inert on non-PDF surfaces)", () => {
    const editor = makeEditor(paragraphs("a", "b"));

    expect(cuedTexts(editor)).toEqual([]);
  });

  it("cues only uncorrected suggested blocks", () => {
    const editor = makeEditor(paragraphs("a", "b", "c", "d"));

    setExtractionEvidence(
      editor,
      evidenceMap(
        evidenceItem({ blockId: "a", reviewSuggested: true }),
        evidenceItem({ blockId: "b", corrected: true, reviewSuggested: true }),
        evidenceItem({ blockId: "c", reviewSuggested: false }),
        evidenceItem({ blockId: "d", confidence: null, reviewSuggested: false })
      )
    );

    expect(cuedTexts(editor)).toEqual(["a"]);
  });

  it("clears a block's cue when new evidence marks it corrected", () => {
    const editor = makeEditor(paragraphs("a", "b"));

    setExtractionEvidence(
      editor,
      evidenceMap(evidenceItem({ blockId: "a" }), evidenceItem({ blockId: "b" }))
    );
    expect(cuedTexts(editor)).toEqual(["a", "b"]);

    setExtractionEvidence(
      editor,
      evidenceMap(evidenceItem({ blockId: "a", corrected: true }), evidenceItem({ blockId: "b" }))
    );
    expect(cuedTexts(editor)).toEqual(["b"]);
  });

  it("keeps the cue on a block by id across an edit to another block", () => {
    const editor = makeEditor(paragraphs("a", "b"));

    setExtractionEvidence(editor, evidenceMap(evidenceItem({ blockId: "b" })));
    expect(cuedTexts(editor)).toEqual(["b"]);

    // Editing the FIRST block shifts the second block's position; the cue is keyed by node id, so it
    // stays on block "b" (its text is unchanged) rather than tracking a stale position.
    editor.chain().setTextSelection(2).insertContent(" more").run();

    expect(cuedTexts(editor)).toEqual(["b"]);
  });

  it("ignores evidence for a block id that is not present", () => {
    const editor = makeEditor(paragraphs("a"));

    setExtractionEvidence(editor, evidenceMap(evidenceItem({ blockId: "missing" })));

    expect(cuedTexts(editor)).toEqual([]);
  });

  it("preserves the current evidence when a malformed meta is dispatched", () => {
    const editor = makeEditor(paragraphs("a"));

    setExtractionEvidence(editor, evidenceMap(evidenceItem({ blockId: "a" })));
    expect(cuedTexts(editor)).toEqual(["a"]);

    for (const malformed of [null, "not-an-object", {}, { evidence: "nope" }]) {
      editor.view.dispatch(editor.state.tr.setMeta(extractionEvidenceKey, malformed));
      expect(cuedTexts(editor)).toEqual(["a"]);
    }
  });
});
