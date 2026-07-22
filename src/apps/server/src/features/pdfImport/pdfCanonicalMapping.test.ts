import type { StructuredDocItem, StructuredDocument, StructuredPage } from "@whetstone/contracts";
import { STRUCTURED_DOCUMENT_SCHEMA_VERSION } from "@whetstone/contracts";
import { parseDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import { mapStructuredDocument, type PdfCanonicalMappingResult } from "./pdfCanonicalMapping.js";

function item(partial: Partial<StructuredDocItem> & { label: string }): StructuredDocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, 5],
    children: [],
    confidence: 0.9,
    label: partial.label,
    pageNumber: 1,
    text: "",
    ...partial
  };
}

function doc(
  body: readonly StructuredDocItem[],
  pages: readonly StructuredPage[] = [{ hasNativeText: true, pageNumber: 1 }]
): StructuredDocument {
  return {
    body,
    doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
    furniture: [],
    pages,
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    source: { byteLength: 10, pageCount: pages.length, sha256: "a".repeat(64) }
  };
}

function mapped(
  result: PdfCanonicalMappingResult
): Extract<PdfCanonicalMappingResult, { status: "mapped" }> {
  if (result.status !== "mapped") {
    throw new Error(`expected mapped, got ${result.status}`);
  }
  return result;
}

// The concatenation of a unit's doc-block node types, so a test can assert the projected structure.
function unitTypes(
  result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>,
  index: number
): string[] {
  return result.units[index]!.docBlocks.map((block) => block.type);
}

describe("mapStructuredDocument", () => {
  it("refuses a document with any non-native-text page as ocr_required and maps no content", () => {
    const result = mapStructuredDocument(
      doc(
        [item({ label: "text", text: "Body" })],
        [
          { hasNativeText: true, pageNumber: 1 },
          { hasNativeText: false, pageNumber: 2 },
          { hasNativeText: false, pageNumber: 3 }
        ]
      )
    );
    expect(result).toEqual({ pagesNeedingOcr: 2, status: "ocr_required" });
  });

  it("projects title to a level-1 heading and section_header to a level-2 heading", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "title", text: "The Work" }),
          item({ label: "section_header", text: "First Section" })
        ])
      )
    );
    // Each heading starts its own unit.
    expect(result.units).toHaveLength(2);
    const title = result.units[0]!.docBlocks[0]!.node;
    const section = result.units[1]!.docBlocks[0]!.node;
    expect(title.type).toBe("heading");
    expect((title.attrs as { level: number }).level).toBe(1);
    expect((section.attrs as { level: number }).level).toBe(2);
    expect(result.units[0]!.title).toBe("The Work");
    expect(result.units[1]!.title).toBe("First Section");
  });

  it("projects text, paragraph, and top-level caption labels to paragraphs", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "text", text: "Plain text." }),
          item({ label: "paragraph", text: "A paragraph." }),
          item({ label: "caption", text: "A stray caption." })
        ])
      )
    );
    expect(unitTypes(result, 0)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("projects formula and code labels to code blocks, preserving text verbatim", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "formula", text: "E = mc^2" }),
          item({ label: "code", text: "print(1)" })
        ])
      )
    );
    const blocks = result.units[0]!.docBlocks;
    expect(blocks.map((b) => b.type)).toEqual(["codeBlock", "codeBlock"]);
    expect(blocks[0]!.node.content?.[0]?.text).toBe("E = mc^2");
  });

  it("projects footnote, endnote, and reference labels to footnote targets", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "footnote", text: "1. A note." }),
          item({ label: "endnote", text: "2. An endnote." }),
          item({ label: "reference", text: "Smith 2020." })
        ])
      )
    );
    expect(unitTypes(result, 0)).toEqual(["footnoteTarget", "footnoteTarget", "footnoteTarget"]);
  });

  it("projects a picture with a caption child to a figure with a caption", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({
            children: [item({ label: "caption", text: "Figure 1. A diagram." })],
            label: "picture"
          })
        ])
      )
    );
    const figure = result.units[0]!.docBlocks[0]!.node;
    expect(figure.type).toBe("figure");
    expect(figure.content?.map((child) => child.type)).toEqual(["image", "figureCaption"]);
  });

  it("projects a figure label using its own text as the caption", () => {
    const result = mapped(
      mapStructuredDocument(doc([item({ label: "figure", text: "Inline figure caption." })]))
    );
    const figure = result.units[0]!.docBlocks[0]!.node;
    expect(figure.content?.map((child) => child.type)).toEqual(["image", "figureCaption"]);
  });

  it("projects a caption-less picture to a figure with only an image", () => {
    const result = mapped(mapStructuredDocument(doc([item({ label: "picture", text: "" })])));
    const figure = result.units[0]!.docBlocks[0]!.node;
    expect(figure.content?.map((child) => child.type)).toEqual(["image"]);
  });

  it("projects a table with rows into a table, marking header cells", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({
            children: [
              item({
                children: [
                  item({ label: "table_header", text: "Name" }),
                  item({ label: "table_cell", text: "Age" })
                ],
                label: "table_row"
              }),
              item({
                children: [
                  item({ label: "table_cell", text: "Ada" }),
                  item({ label: "table_cell", text: "36" })
                ],
                label: "table_row"
              })
            ],
            label: "table"
          })
        ])
      )
    );
    const table = result.units[0]!.docBlocks[0]!.node;
    expect(table.type).toBe("table");
    const firstRow = table.content?.[0]?.content?.map((cell) => cell.type);
    expect(firstRow).toEqual(["tableHeader", "tableCell"]);
  });

  it("falls back to an unknown node for a table with no rows", () => {
    const result = mapped(mapStructuredDocument(doc([item({ label: "table", text: "orphan" })])));
    expect(result.units[0]!.docBlocks[0]!.type).toBe("unknown");
    expect(result.unmappedLabels).toContain("table");
  });

  it("skips non-row children and empty rows while still building a table", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({
            children: [
              item({ label: "caption", text: "Table 1." }),
              item({ children: [], label: "table_row" }),
              item({ children: [item({ label: "table_cell", text: "Cell" })], label: "table_row" })
            ],
            label: "table"
          })
        ])
      )
    );
    const table = result.units[0]!.docBlocks[0]!.node;
    expect(table.type).toBe("table");
    // Only the non-empty row survives.
    expect(table.content).toHaveLength(1);
  });

  it("projects an ordered list group with nested lists", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({
            children: [
              item({
                children: [
                  item({
                    children: [item({ label: "list_item", text: "Nested" })],
                    label: "list"
                  })
                ],
                label: "list_item",
                text: "Top"
              })
            ],
            label: "ordered_list"
          })
        ])
      )
    );
    const list = result.units[0]!.docBlocks[0]!.node;
    expect(list.type).toBe("orderedList");
    const listItem = list.content?.[0];
    expect(listItem?.content?.map((child) => child.type)).toEqual(["paragraph", "bulletList"]);
  });

  it("falls back to an unknown node for a list group with no list items", () => {
    const result = mapped(
      mapStructuredDocument(doc([item({ label: "unordered_list", text: "x" })]))
    );
    expect(result.units[0]!.docBlocks[0]!.type).toBe("unknown");
  });

  it("ignores non-list and empty nested groups inside a list item", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({
            children: [
              item({
                children: [
                  item({ label: "text", text: "not a list" }),
                  item({ children: [], label: "list" })
                ],
                label: "list_item",
                text: "Only a paragraph"
              })
            ],
            label: "list"
          })
        ])
      )
    );
    const listItem = result.units[0]!.docBlocks[0]!.node.content?.[0];
    // The non-list child and the empty nested list group are both dropped: only the paragraph remains.
    expect(listItem?.content?.map((child) => child.type)).toEqual(["paragraph"]);
  });

  it("groups a run of top-level list items into one bullet list", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "list_item", text: "One" }),
          item({ label: "list_item", text: "Two" }),
          item({ label: "text", text: "After the list." })
        ])
      )
    );
    expect(unitTypes(result, 0)).toEqual(["bulletList", "paragraph"]);
    const list = result.units[0]!.docBlocks[0]!.node;
    expect(list.content).toHaveLength(2);
  });

  it("preserves an unrecognized label as a visible unknown node and records it", () => {
    const result = mapped(
      mapStructuredDocument(doc([item({ label: "some_unknown_label", text: "unsure." })]))
    );
    const unknown = result.units[0]!.docBlocks[0]!.node;
    expect(unknown.type).toBe("unknown");
    expect((unknown.attrs as { html: string; tag: string }).html).toBe("unsure.");
    expect((unknown.attrs as { tag: string }).tag).toBe("some_unknown_label");
    expect(result.unmappedLabels).toEqual(["some_unknown_label"]);
  });

  it("puts a leading run before the first heading into a neutral Start unit", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "text", text: "Preamble." }),
          item({ label: "title", text: "Chapter" }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    expect(result.units).toHaveLength(2);
    expect(result.units[0]!.title).toBeUndefined();
    expect(unitTypes(result, 0)).toEqual(["paragraph"]);
    expect(unitTypes(result, 1)).toEqual(["heading", "paragraph"]);
  });

  it("treats a whitespace-only heading as an untitled unit", () => {
    const result = mapped(mapStructuredDocument(doc([item({ label: "title", text: "   " })])));
    expect(result.units[0]!.title).toBeUndefined();
  });

  it("projects an empty-text block to a block with no inline content", () => {
    const result = mapped(mapStructuredDocument(doc([item({ label: "text", text: "" })])));
    const block = result.units[0]!.docBlocks[0]!.node;
    expect(block.type).toBe("paragraph");
    expect(block.content ?? []).toEqual([]);
  });

  it("returns no units for an empty body", () => {
    const result = mapped(mapStructuredDocument(doc([])));
    expect(result.units).toHaveLength(0);
    expect(result.evidence).toHaveLength(0);
  });

  it("keys additive evidence to each block's stable id with page geometry and confidence", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({
            boundingBox: { bottom: 40, left: 10, right: 90, top: 20 },
            charSpan: [3, 11],
            confidence: 0.42,
            label: "text",
            pageNumber: 7,
            text: "Measured."
          })
        ])
      )
    );
    const block = result.units[0]!.docBlocks[0]!;
    expect(result.evidence).toEqual([
      {
        blockId: block.id,
        boundingBox: { bottom: 40, left: 10, right: 90, top: 20 },
        charEnd: 11,
        charStart: 3,
        confidence: 0.42,
        label: "text",
        page: 7
      }
    ]);
  });

  it("produces schema-valid documents for every projected unit", () => {
    const result = mapped(
      mapStructuredDocument(
        doc([
          item({ label: "title", text: "Doc" }),
          item({ label: "text", text: "Para" }),
          item({ label: "formula", text: "x+y" })
        ])
      )
    );
    for (const unit of result.units) {
      expect(() =>
        parseDocument({ content: unit.docBlocks.map((block) => block.node), type: "doc" })
      ).not.toThrow();
    }
  });
});
