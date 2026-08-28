import type {
  PdfOutlineEntry,
  StructuredDocItem,
  StructuredDocument,
  StructuredPage
} from "@whetstone/contracts";
import { STRUCTURED_DOCUMENT_SCHEMA_VERSION } from "@whetstone/contracts";
import { documentText, parseDocument, type DocumentNodeJSON } from "@whetstone/document";
import {
  classifyExtractionConfidence,
  isUnmappedBlockType,
  PDF_EXTRACTION_CONFIDENCE_THRESHOLD,
  suggestsExtractionReview
} from "@whetstone/domain";
import { describe, expect, it } from "vitest";

import { mapStructuredDocument, type PdfCanonicalMappingResult } from "./pdfCanonicalMapping.js";

// `mapStructuredDocument` is language-independent — OCR routing is decided upstream by the resolved
// attempt language, and text-less pages that survive to mapping are always refused as validation failures.
function mapEn(document: StructuredDocument): PdfCanonicalMappingResult {
  return mapStructuredDocument(document);
}

function item(partial: Partial<StructuredDocItem> & { label: string }): StructuredDocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, 5],
    children: [],
    confidence: 0.9,
    pageNumber: 1,
    text: "",
    ...partial
  };
}

function doc(
  body: readonly StructuredDocItem[],
  pages: readonly StructuredPage[] = [{ hasNativeText: true, pageNumber: 1 }],
  outline?: readonly PdfOutlineEntry[]
): StructuredDocument {
  return {
    body,
    doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
    furniture: [],
    pages,
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    source: { byteLength: 10, pageCount: pages.length, sha256: "a".repeat(64) },
    ...(outline === undefined ? {} : { outline })
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

// Every heading BLOCK in the work, in order — not one per unit: since #816 a reading unit is a
// chapter-scale division, so a chapter's sections are heading blocks INSIDE it rather than units.
function headingNodes(
  result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>
): DocumentNodeJSON[] {
  return result.units
    .flatMap((unit) => unit.docBlocks)
    .map((block) => block.node)
    .filter((node) => node.type === "heading");
}

function headingLevels(result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>): number[] {
  return headingNodes(result).map((node) => (node.attrs as { level: number }).level);
}

// The text of each heading block, so a test can assert WHICH headings survived (and that no running head
// was duplicated into one) independently of how the work is divided into units.
function headingTexts(result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>): string[] {
  return headingNodes(result).map((node) =>
    (node.content ?? []).map((inline) => inline.text ?? "").join("")
  );
}

describe("mapStructuredDocument", () => {
  it("refuses a text-less document as ocr_validation_failed and maps no content", () => {
    // Text-less pages surviving to mapping mean the OCR pass and the full conversion disagreed, or OCR was
    // incomplete — the whole publication is refused, no partial Work, regardless of the OCR language chosen.
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
    expect(result).toEqual({ pagesNeedingOcr: 2, status: "ocr_validation_failed" });
  });

  it("projects title to a level-1 heading and section_header to a level-2 heading", () => {
    // The label table is the LAST-RESORT fallback (#815): with no outline to derive depth from, a
    // document keeps the flat label-derived levels and says so in `headingLevelSources`.
    const result = mapped(
      mapEn(
        doc([
          item({ label: "title", text: "The Work" }),
          item({ label: "section_header", text: "First Section" })
        ])
      )
    );
    // No authored outline, so the fallback divides at the shallowest level present (#816): the `title`
    // opens the only unit and the deeper section stays a heading block inside it.
    expect(result.units).toHaveLength(1);
    const [title, section] = result.units[0]!.docBlocks.map((block) => block.node);
    expect(title!.type).toBe("heading");
    expect((title!.attrs as { level: number }).level).toBe(1);
    expect((section!.attrs as { level: number }).level).toBe(2);
    expect(result.units[0]!.title).toBe("The Work");
    expect(result.headingLevelSources).toEqual({ label: 2, outline: 0 });
  });

  it("projects text, paragraph, and top-level caption labels to paragraphs", () => {
    const result = mapped(
      mapEn(
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
      mapEn(
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
      mapEn(
        doc([
          item({ label: "footnote", text: "1. A note." }),
          item({ label: "endnote", text: "2. An endnote." }),
          item({ label: "reference", text: "Smith 2020." })
        ])
      )
    );
    expect(unitTypes(result, 0)).toEqual(["footnoteTarget", "footnoteTarget", "footnoteTarget"]);
  });

  it("maps a picture with a caption to a canonical figure placeholder, keeping the readable text (#806)", () => {
    const result = mapped(
      mapEn(
        doc([
          item({ label: "text", text: "Body" }),
          item({
            children: [item({ label: "caption", text: "Figure 1. A diagram." })],
            label: "picture",
            pageNumber: 4
          })
        ])
      )
    );
    // The readable paragraph still publishes; the picture becomes a visible figure, never a refusal.
    expect(unitTypes(result, 0)).toEqual(["paragraph", "figure"]);
    expect(result.unresolvedFigureCount).toBe(1);

    const figure = result.units[0]!.docBlocks[1]!.node;
    const [image, caption] = figure.content as DocumentNodeJSON[];
    expect(image!.type).toBe("image");
    // A non-decorative fallback label names the source page; the image is unresolved (no resource/src yet).
    expect(image!.attrs).toMatchObject({
      alt: "Figure from PDF page 4 (image not yet extracted)",
      imageResourceId: null,
      src: null
    });
    expect(caption!.type).toBe("figureCaption");
    expect(caption!.content).toEqual([{ text: "Figure 1. A diagram.", type: "text" }]);
  });

  it("maps a captionless figure label to a figure placeholder with no caption (#806)", () => {
    const result = mapped(mapEn(doc([item({ label: "figure", text: "" })])));
    expect(result.unresolvedFigureCount).toBe(1);
    const figure = result.units[0]!.docBlocks[0]!.node;
    expect(figure.type).toBe("figure");
    const content = figure.content as DocumentNodeJSON[];
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe("image");
  });

  it("resolves a picture with an adopted artifact into a figure carrying the content-addressed image (#807)", () => {
    const sha = "b".repeat(64);
    const result = mapped(
      mapEn(
        doc([
          item({ label: "text", text: "Body" }),
          item({
            children: [item({ label: "caption", text: "Figure 1. A rendered diagram." })],
            label: "picture",
            pageNumber: 4,
            imageArtifact: {
              path: "0/fig-0.png",
              contentType: "image/png",
              sha256: sha,
              byteLength: 128,
              width: 320,
              height: 200
            }
          })
        ])
      )
    );
    // A resolved figure is NOT counted as an unresolved-figure warning.
    expect(unitTypes(result, 0)).toEqual(["paragraph", "figure"]);
    expect(result.unresolvedFigureCount).toBe(0);

    const figure = result.units[0]!.docBlocks[1]!.node;
    const [image, caption] = figure.content as DocumentNodeJSON[];
    expect(image!.type).toBe("image");
    // The image carries the content-addressed id (the artifact sha256) and a caption-derived alt.
    expect(image!.attrs).toMatchObject({
      alt: "Figure 1. A rendered diagram.",
      imageResourceId: sha,
      src: null
    });
    expect(caption!.type).toBe("figureCaption");
  });

  it("uses a page-locator alt for a resolved figure that has no caption (#807)", () => {
    const sha = "c".repeat(64);
    const result = mapped(
      mapEn(
        doc([
          item({
            label: "picture",
            pageNumber: 7,
            imageArtifact: {
              path: "0/fig-0.png",
              contentType: "image/png",
              sha256: sha,
              byteLength: 64,
              width: 10,
              height: 10
            }
          })
        ])
      )
    );
    expect(result.unresolvedFigureCount).toBe(0);
    const figure = result.units[0]!.docBlocks[0]!.node;
    const [image] = figure.content as DocumentNodeJSON[];
    expect(image!.attrs).toMatchObject({
      alt: "Figure from PDF page 7",
      imageResourceId: sha,
      src: null
    });
  });

  it("counts every top-level picture/figure as an unresolved figure (#806)", () => {
    const result = mapped(
      mapEn(
        doc([
          item({ label: "text", text: "Intro" }),
          item({ label: "picture", text: "" }),
          item({ label: "figure", text: "" })
        ])
      )
    );
    expect(unitTypes(result, 0)).toEqual(["paragraph", "figure", "figure"]);
    expect(result.unresolvedFigureCount).toBe(2);
  });

  it("adopts a picture's own text as the caption when it has no caption child (#806)", () => {
    const result = mapped(mapEn(doc([item({ label: "picture", text: "Standalone caption." })])));
    const figure = result.units[0]!.docBlocks[0]!.node;
    const caption = (figure.content as DocumentNodeJSON[])[1];
    expect(caption!.type).toBe("figureCaption");
    expect(caption!.content).toEqual([{ text: "Standalone caption.", type: "text" }]);
  });

  it("projects a table with rows into a table, marking header cells", () => {
    const result = mapped(
      mapEn(
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
    const result = mapped(mapEn(doc([item({ label: "table", text: "orphan" })])));
    expect(result.units[0]!.docBlocks[0]!.type).toBe("unknown");
    expect(result.unmappedLabels).toContain("table");
  });

  it("skips non-row children and empty rows while still building a table", () => {
    const result = mapped(
      mapEn(
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
      mapEn(
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
    const result = mapped(mapEn(doc([item({ label: "unordered_list", text: "x" })])));
    expect(result.units[0]!.docBlocks[0]!.type).toBe("unknown");
  });

  it("ignores non-list and empty nested groups inside a list item", () => {
    const result = mapped(
      mapEn(
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
      mapEn(
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
    const result = mapped(mapEn(doc([item({ label: "some_unknown_label", text: "unsure." })])));
    const unknown = result.units[0]!.docBlocks[0]!.node;
    expect(unknown.type).toBe("unknown");
    expect((unknown.attrs as { html: string; tag: string }).html).toBe("unsure.");
    expect((unknown.attrs as { tag: string }).tag).toBe("some_unknown_label");
    expect(result.unmappedLabels).toEqual(["some_unknown_label"]);
  });

  it("puts a leading run before the first heading into a neutral Start unit", () => {
    const result = mapped(
      mapEn(
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
    const result = mapped(mapEn(doc([item({ label: "title", text: "   " })])));
    expect(result.units[0]!.title).toBeUndefined();
  });

  it("projects an empty-text block to a block with no inline content", () => {
    const result = mapped(mapEn(doc([item({ label: "text", text: "" })])));
    const block = result.units[0]!.docBlocks[0]!.node;
    expect(block.type).toBe("paragraph");
    expect(block.content ?? []).toEqual([]);
  });

  it("refuses an empty body as no_content, creating no units", () => {
    expect(mapEn(doc([]))).toEqual({ status: "no_content" });
  });

  it("keys additive evidence to each block's stable id with page geometry and confidence", () => {
    const result = mapped(
      mapEn(
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
      mapEn(
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

// Page furniture (#811): docling emits running heads, running feet, and folios INSIDE `doc.body`, and its
// own `furniture` group is deprecated and arrives empty, so the mapper is the only place that can keep
// layout debris out of the readable hierarchy — and the only place that can account for what it removed.
describe("mapStructuredDocument page-furniture exclusion", () => {
  const pages: readonly StructuredPage[] = [
    { hasNativeText: true, pageNumber: 1 },
    { hasNativeText: true, pageNumber: 2 },
    { hasNativeText: true, pageNumber: 3 }
  ];

  it("excludes folios and running heads from the body and reports them as evidence", () => {
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "page_header", pageNumber: 1, text: "Chapter 5: Formatting" }),
            item({ label: "page_footer", pageNumber: 1, text: "\u2014 89 \u2014" }),
            item({ label: "text", pageNumber: 1, text: "Readable prose." }),
            item({ label: "page_header", pageNumber: 2, text: "Chapter 5: Formatting" }),
            item({ label: "page_footer", pageNumber: 2, text: "90" }),
            item({ label: "text", pageNumber: 2, text: "More prose." })
          ],
          pages
        )
      )
    );

    // Only the two readable paragraphs became blocks; no furniture block, and none on the unknown path.
    expect(unitTypes(result, 0)).toEqual(["paragraph", "paragraph"]);
    expect(result.unmappedLabels).toEqual([]);
    expect(result.evidence.map((row) => row.label)).toEqual(["text", "text"]);

    expect(result.excludedFurniture).toEqual([
      {
        label: "page_header",
        normalizedText: "chapter 5: formatting",
        page: 1,
        rule: "repeated-across-pages"
      },
      { label: "page_footer", normalizedText: "89", page: 1, rule: "folio" },
      {
        label: "page_header",
        normalizedText: "chapter 5: formatting",
        page: 2,
        rule: "repeated-across-pages"
      },
      { label: "page_footer", normalizedText: "90", page: 2, rule: "folio" }
    ]);
    expect(result.excludedFurnitureCount).toBe(4);
    // Excluded characters count the RAW source text (not the normalized form), so the caller can measure
    // what share of the text layer left the body.
    expect(result.excludedFurnitureCharacters).toBe(
      "Chapter 5: Formatting".length +
        "\u2014 89 \u2014".length +
        "Chapter 5: Formatting".length +
        2
    );
  });

  it("excludes a running head that repeats across page ranges of one document", () => {
    // The mapper sees the WHOLE document (every committed range concatenated), so a head printed once per
    // range is still detectable as repetition — a per-range view could never see it.
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "page_header", pageNumber: 1, text: "Clean Code" }),
            item({ label: "text", pageNumber: 1, text: "Range one prose." }),
            item({ label: "page_header", pageNumber: 3, text: "Clean Code" }),
            item({ label: "text", pageNumber: 3, text: "Range two prose." })
          ],
          pages
        )
      )
    );
    expect(unitTypes(result, 0)).toEqual(["paragraph", "paragraph"]);
    expect(result.excludedFurniture.map((row) => row.rule)).toEqual([
      "repeated-across-pages",
      "repeated-across-pages"
    ]);
  });

  it("excludes a one-off running head that restates a heading the document carries", () => {
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "page_header", pageNumber: 2, text: "The Law of Demeter" }),
            item({ label: "section_header", pageNumber: 2, text: "The Law of Demeter" }),
            item({ label: "text", pageNumber: 2, text: "Prose." })
          ],
          pages
        )
      )
    );
    expect(unitTypes(result, 0)).toEqual(["heading", "paragraph"]);
    expect(result.excludedFurniture).toEqual([
      {
        label: "page_header",
        normalizedText: "the law of demeter",
        page: 2,
        rule: "matches-heading"
      }
    ]);
  });

  it("keeps a unique page_header as a readable paragraph instead of an unknown block", () => {
    // Docling labels some chapter openers `page_header`. Silently discarding a unique candidate would
    // destroy content, and the old `unknown` fallback rendered it as dashed debris.
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "page_header", pageNumber: 1, text: "Chapter 3: Functions" }),
            item({ label: "text", pageNumber: 1, text: "Prose." }),
            item({ label: "page_footer", pageNumber: 2, text: "1. [Martin]." })
          ],
          pages
        )
      )
    );
    expect(unitTypes(result, 0)).toEqual(["paragraph", "paragraph", "paragraph"]);
    const kept = result.units[0]!.docBlocks[0]!.node;
    expect(kept.content).toEqual([{ text: "Chapter 3: Functions", type: "text" }]);
    // Neither kept label reaches the unknown/fallback path, so neither is reported as unmapped.
    expect(result.unmappedLabels).toEqual([]);
    expect(result.excludedFurniture).toEqual([]);
    expect(result.excludedFurnitureCount).toBe(0);
    expect(result.excludedFurnitureCharacters).toBe(0);
  });

  it("keeps surviving blocks in source order with their own page, geometry, and confidence", () => {
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "page_header", pageNumber: 1, text: "1" }),
            item({
              boundingBox: { bottom: 30, left: 5, right: 95, top: 10 },
              charSpan: [4, 20],
              confidence: 0.71,
              label: "text",
              pageNumber: 1,
              text: "First."
            }),
            item({ label: "page_footer", pageNumber: 1, text: "Running foot" }),
            item({ label: "section_header", pageNumber: 2, text: "Second Section" }),
            item({ label: "page_footer", pageNumber: 2, text: "Running foot" }),
            item({
              boundingBox: { bottom: 60, left: 6, right: 96, top: 40 },
              charSpan: [30, 44],
              confidence: 0.55,
              label: "text",
              pageNumber: 2,
              text: "Second."
            })
          ],
          pages
        )
      )
    );

    expect(unitTypes(result, 0)).toEqual(["paragraph"]);
    expect(unitTypes(result, 1)).toEqual(["heading", "paragraph"]);
    // Evidence still describes the surviving blocks only, in source order, each with its own geometry.
    expect(
      result.evidence.map((row) => ({
        confidence: row.confidence,
        label: row.label,
        page: row.page,
        top: row.boundingBox.top
      }))
    ).toEqual([
      { confidence: 0.71, label: "text", page: 1, top: 10 },
      { confidence: 0.9, label: "section_header", page: 2, top: 0 },
      { confidence: 0.55, label: "text", page: 2, top: 40 }
    ]);
    expect(result.excludedFurniture.map((row) => [row.page, row.rule])).toEqual([
      [1, "folio"],
      [1, "repeated-across-pages"],
      [2, "repeated-across-pages"]
    ]);
  });

  it("refuses a document whose body is entirely furniture as no_content, never a new refusal kind", () => {
    // Exclusion is not a refusal reason: a furniture-only body simply has no readable content, so it
    // takes the SAME typed `no_content` outcome an empty body does — no empty-shell Work either way.
    const result = mapEn(
      doc(
        [
          item({ label: "page_header", pageNumber: 1, text: "Clean Code" }),
          item({ label: "page_footer", pageNumber: 1, text: "12" }),
          item({ label: "page_header", pageNumber: 2, text: "Clean Code" }),
          item({ label: "page_footer", pageNumber: 2, text: "13" })
        ],
        pages
      )
    );
    expect(result).toEqual({ status: "no_content" });
  });

  it("reports no furniture for a document that has none", () => {
    const result = mapped(mapEn(doc([item({ label: "text", text: "Just prose." })])));
    expect(result.excludedFurniture).toEqual([]);
    expect(result.excludedFurnitureCount).toBe(0);
    expect(result.excludedFurnitureCharacters).toBe(0);
  });
});

// #812 — an unrecognized construct is a CONTAINER, not a leaf. Docling groups carry their text in
// children, so the pre-#812 fallback (keep the parent's own `text`, drop `children`) erased whole
// subtrees. Measured on the published Clean Code import (462 pages, the attempt behind work
// 7b9b5e8f-5965-4895-882b-aa13dc137ac1): 39 `unknown` blocks, EVERY one of them holding zero
// characters, above 71,510 characters of descendants that reached neither `plaintext` nor `node_json`.
//
// The two fixtures below are VERBATIM items from that attempt's stored `pdf_import_ranges.payload` —
// the immutable provenance the worker actually emitted, not an invented shape — so these tests fail if
// the mapper stops handling the constructs real books contain.
const REAL_KEY_VALUE_AREA: StructuredDocItem = {
  boundingBox: {
    bottom: 84.06688436942761,
    left: 35.828912,
    right: 68.869856,
    top: 91.41744238671868
  },
  charSpan: [0, 25],
  children: [
    {
      boundingBox: {
        bottom: 84.06688436942761,
        left: 35.828912,
        right: 68.869856,
        top: 91.41744238671868
      },
      charSpan: [0, 8],
      children: [],
      confidence: 1,
      label: "text",
      pageNumber: 5,
      text: "ISBN-13:"
    },
    {
      boundingBox: {
        bottom: 84.06688436942761,
        left: 73.185824,
        right: 139.726496,
        top: 91.41744238671868
      },
      charSpan: [0, 17],
      children: [],
      confidence: 1,
      label: "text",
      pageNumber: 5,
      text: "978-0-13-235088-4"
    },
    {
      boundingBox: {
        bottom: 75.06962036942764,
        left: 35.828912,
        right: 68.8817504,
        top: 82.4201783867187
      },
      charSpan: [0, 8],
      children: [],
      confidence: 1,
      label: "text",
      pageNumber: 5,
      text: "ISBN-10:"
    },
    {
      boundingBox: {
        bottom: 75.06962036942764,
        left: 73.1994176,
        right: 139.7961632,
        top: 82.4201783867187
      },
      charSpan: [0, 13],
      children: [],
      confidence: 1,
      label: "text",
      pageNumber: 5,
      text: "0-13-235088-2"
    },
    {
      boundingBox: {
        bottom: 66.07235636942767,
        left: 35.828912,
        right: 345.77148799999986,
        top: 73.42291438671873
      },
      charSpan: [0, 91],
      children: [],
      confidence: 1,
      label: "text",
      pageNumber: 5,
      text: "Text printed in the United States on recycled paper at Courier in Stoughton, Massachusetts."
    },
    {
      boundingBox: {
        bottom: 57.07509236942769,
        left: 35.828912,
        right: 116.982704,
        top: 64.42565038671876
      },
      charSpan: [0, 25],
      children: [],
      confidence: 1,
      label: "text",
      pageNumber: 5,
      text: "First printing July, 2008"
    }
  ],
  confidence: 1,
  label: "key_value_area",
  pageNumber: 5,
  text: ""
};

// The book's own table of contents. Docling labels it `document_index` and gives it the SAME
// `table_row` -> cell shape a `table` has, so the pre-#812 mapper dropped every entry.
const REAL_DOCUMENT_INDEX: StructuredDocItem = {
  boundingBox: {
    bottom: 81.68646240234375,
    left: 77.95601654052734,
    right: 439.6841125488281,
    top: 486.7313537597656
  },
  charSpan: [0, 0],
  children: [
    {
      boundingBox: { bottom: 0, left: 0, right: 0, top: 0 },
      charSpan: [0, 0],
      children: [
        {
          boundingBox: {
            bottom: 193.0534014409222,
            left: 78.825,
            right: 420.74299999999994,
            top: 180.9409
          },
          charSpan: [0, 0],
          children: [],
          confidence: 1,
          label: "table_cell",
          pageNumber: 8,
          text: "Foreword......"
        },
        {
          boundingBox: {
            bottom: 192.647044092219,
            left: 423.68899999999996,
            right: 439.025,
            top: 182.26489999999995
          },
          charSpan: [0, 0],
          children: [],
          confidence: 1,
          label: "table_cell",
          pageNumber: 8,
          text: "xix"
        }
      ],
      confidence: 1,
      label: "table_row",
      pageNumber: 8,
      text: ""
    },
    {
      boundingBox: { bottom: 0, left: 0, right: 0, top: 0 },
      charSpan: [0, 0],
      children: [
        {
          boundingBox: {
            bottom: 221.05350144092222,
            left: 78.82600000000001,
            right: 439.0118,
            top: 208.94099999999997
          },
          charSpan: [0, 0],
          children: [],
          confidence: 1,
          label: "table_cell",
          pageNumber: 8,
          text: "Introduction ......xxv"
        }
      ],
      confidence: 1,
      label: "table_row",
      pageNumber: 8,
      text: ""
    }
  ],
  confidence: 1,
  label: "document_index",
  pageNumber: 8,
  text: ""
};

// Wrap `leaf` in `levels` nested unrecognized containers, so `wrapper_0` sits at expansion depth 0 and
// `wrapper_{levels-1}` at depth `levels - 1`.
function nestUnknownContainers(levels: number, leaf: StructuredDocItem): StructuredDocItem {
  let current = leaf;
  for (let level = levels - 1; level >= 0; level -= 1) {
    current = item({ children: [current], label: `wrapper_${level}` });
  }
  return current;
}

// The plain text a block renders, whatever node type it took: an `unknown` keeps it verbatim in `html`,
// every other node in its inline content. Asserting on this proves the CONTENT survived, not merely that
// some block was produced.
function blockText(node: DocumentNodeJSON): string {
  const html = (node.attrs as { html?: unknown } | undefined)?.html;
  if (typeof html === "string") {
    return html;
  }
  const own = typeof node.text === "string" ? node.text : "";
  return (node.content ?? []).reduce<string>((text, child) => text + blockText(child), own);
}

function blockTexts(result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>): string[] {
  return result.units.flatMap((unit) => unit.docBlocks.map((block) => blockText(block.node)));
}

describe("unrecognized containers keep their descendants (#812)", () => {
  it("recovers a real key_value_area's children as ordinary paragraphs instead of one empty block", () => {
    // The verbatim Clean Code p5 construct: a group whose own text is empty and whose six `text`
    // children carry every character. Pre-#812 this produced ONE block holding `html: ""`.
    const result = mapped(mapEn(doc([REAL_KEY_VALUE_AREA])));

    expect(unitTypes(result, 0)).toEqual([
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph",
      "paragraph"
    ]);
    expect(blockTexts(result)).toEqual([
      "ISBN-13:",
      "978-0-13-235088-4",
      "ISBN-10:",
      "0-13-235088-2",
      "Text printed in the United States on recycled paper at Courier in Stoughton, Massachusetts.",
      "First printing July, 2008"
    ]);
    // The construct itself carried nothing to show, so it contributes no block — but the gap is still
    // reported, so an unrecognized label never becomes invisible.
    expect(result.unmappedLabels).toEqual(["key_value_area"]);
  });

  it("maps a real document_index to the canonical table it always was, keeping every cell's text", () => {
    // The book's own table of contents. Until #859 this construct was unrecognized, so #812 expanded it
    // and each cell became its own `unknown` block: the text was reachable, but only through an
    // `unknown`'s opaque `html` attr, which `documentText` — and therefore the persisted `plaintext`
    // search and note anchors read — does not see. Docling ships it in the `_table_rows` shape, so it
    // now maps to a table and the same characters land in real text nodes.
    const result = mapped(mapEn(doc([REAL_DOCUMENT_INDEX])));

    expect(unitTypes(result, 0)).toEqual(["table"]);
    const table = result.units[0]!.docBlocks[0]!.node;
    expect(table.content?.map((row) => row.content?.map((cell) => cell.type))).toEqual([
      ["tableCell", "tableCell"],
      ["tableCell"]
    ]);
    // Every cell's text survives, in source order — the #812 guarantee, now in the readable projection
    // rather than in an attribute.
    expect(documentText(table)).toBe("Foreword......xixIntroduction ......xxv");
    // Nothing under a mapped construct is unrecognized any more: the container, its rows and its cells
    // are all consumed by the table, so the fail-loud list goes quiet for this shape.
    expect(result.unmappedLabels).toEqual([]);
    // A table-shaped construct now keys ONE evidence row from the container, exactly as a `label: "table"`
    // construct always has — per-cell geometry is not retained for a table by any path, so this is the
    // existing table contract applied to a construct that turned out to be one.
    expect(result.evidence.map((row) => row.label)).toEqual(["document_index"]);
    expect(result.evidence[0]!.boundingBox).toEqual({
      bottom: 81.68646240234375,
      left: 77.95601654052734,
      right: 439.6841125488281,
      top: 486.7313537597656
    });
  });

  it("maps every child of an unrecognized group with the ordinary rules, list-item runs included", () => {
    const result = mapped(
      mapEn(
        doc([
          item({
            children: [
              item({ label: "text", text: "Lead-in." }),
              item({ label: "code", text: "printf();" }),
              item({ label: "list_item", text: "first" }),
              item({ label: "list_item", text: "second" }),
              item({ label: "text", text: "Tail." })
            ],
            label: "comment_section"
          })
        ])
      )
    );

    // The two `list_item`s are grouped into ONE bullet list exactly as a top-level run would be.
    expect(unitTypes(result, 0)).toEqual(["paragraph", "codeBlock", "bulletList", "paragraph"]);
    expect(blockTexts(result)).toEqual(["Lead-in.", "printf();", "firstsecond", "Tail."]);
  });

  it("emits an unrecognized parent's own text as a visible unknown BEFORE its children", () => {
    const result = mapped(
      mapEn(
        doc([
          item({
            children: [item({ label: "text", text: "Inherited." })],
            label: "sidebar",
            text: "Parent evidence."
          })
        ])
      )
    );

    expect(unitTypes(result, 0)).toEqual(["unknown", "paragraph"]);
    expect(blockTexts(result)).toEqual(["Parent evidence.", "Inherited."]);
    expect(result.unmappedLabels).toEqual(["sidebar"]);
  });

  it("keeps an unmapped leaf that carries text exactly as before", () => {
    const result = mapped(mapEn(doc([item({ label: "sidebar", text: "Nothing beneath me." })])));
    const node = result.units[0]!.docBlocks[0]!.node;
    expect(node.type).toBe("unknown");
    expect(node.attrs).toMatchObject({ html: "Nothing beneath me.", tag: "sidebar" });
    expect(result.unmappedLabels).toEqual(["sidebar"]);
  });

  it("emits no block for an unrecognized construct that yields no content, but still reports it", () => {
    // A construct with no text and no children could only render as a blank gap holding a slot in the
    // reading order. It produces nothing — and `unmappedLabels` keeps it fail-loud.
    const result = mapped(
      mapEn(doc([item({ label: "text", text: "Kept." }), item({ label: "key_value_area" })]))
    );

    expect(unitTypes(result, 0)).toEqual(["paragraph"]);
    expect(result.unmappedLabels).toEqual(["key_value_area"]);
    expect(result.evidence.map((row) => row.label)).toEqual(["text"]);
  });

  it("refuses a document whose only constructs are content-less unrecognized ones", () => {
    // No empty-shell Work: nothing renderable was produced, so this is `no_content` rather than a Work
    // of blank blocks (#702).
    const result = mapEn(
      doc([item({ label: "key_value_area" }), item({ children: [], label: "form_area" })])
    );
    expect(result).toEqual({ status: "no_content" });
  });

  it("preserves source order across expanded and ordinary items alike", () => {
    const result = mapped(
      mapEn(
        doc([
          item({ label: "text", text: "one" }),
          item({
            children: [
              item({ label: "text", text: "two" }),
              item({ children: [item({ label: "text", text: "three" })], label: "form_area" }),
              item({ label: "text", text: "four" })
            ],
            label: "key_value_area"
          }),
          item({ label: "text", text: "five" })
        ])
      )
    );

    expect(blockTexts(result)).toEqual(["one", "two", "three", "four", "five"]);
  });

  it("keys each recovered block's evidence to its own descendant item, never the ancestor", () => {
    const result = mapped(
      mapEn(
        doc(
          [
            item({
              children: [
                item({
                  boundingBox: { bottom: 9, left: 8, right: 7, top: 6 },
                  charSpan: [11, 22],
                  confidence: 0.42,
                  label: "text",
                  pageNumber: 7,
                  text: "Deep."
                })
              ],
              // Deliberately contradictory ancestor evidence: nothing below may inherit it.
              boundingBox: { bottom: 1, left: 1, right: 1, top: 1 },
              charSpan: [0, 0],
              confidence: 1,
              label: "key_value_area",
              pageNumber: 1
            })
          ],
          [
            { hasNativeText: true, pageNumber: 1 },
            { hasNativeText: true, pageNumber: 7 }
          ]
        )
      )
    );

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatchObject({
      boundingBox: { bottom: 9, left: 8, right: 7, top: 6 },
      charEnd: 22,
      charStart: 11,
      confidence: 0.42,
      label: "text",
      page: 7
    });
  });

  it("resolves a heading buried in an unrecognized container and starts its reading unit", () => {
    // Expansion runs BEFORE heading resolution, so a lifted heading claims the outline entry that names
    // it and splits the body exactly as a top-level heading would.
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "text", text: "Front matter." }),
            item({
              children: [
                item({ label: "section_header", pageNumber: 2, text: "Chapter 1: Clean Code" }),
                item({ label: "text", pageNumber: 2, text: "Body." })
              ],
              label: "key_value_area",
              pageNumber: 2
            })
          ],
          [
            { hasNativeText: true, pageNumber: 1 },
            { hasNativeText: true, pageNumber: 2 }
          ],
          [{ level: 3, pageNumber: 2, title: "Chapter 1: Clean Code" }]
        )
      )
    );

    expect(result.units.map((unit) => unit.title)).toEqual([undefined, "Chapter 1: Clean Code"]);
    expect(unitTypes(result, 1)).toEqual(["heading", "paragraph"]);
    expect(result.units[1]!.docBlocks[0]!.node.attrs).toMatchObject({ level: 3 });
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 1 });
  });

  it("expands nesting up to the depth bound", () => {
    // 16 wrappers put the payload at exactly the deepest level the mapper walks.
    const result = mapped(
      mapEn(doc([nestUnknownContainers(16, item({ label: "text", text: "Reached." }))]))
    );

    expect(unitTypes(result, 0)).toEqual(["paragraph"]);
    expect(blockTexts(result)).toEqual(["Reached."]);
  });

  it("stops at the depth bound, keeping the held-back container as one visible unknown", () => {
    // One wrapper deeper: `wrapper_16` sits AT the bound, so the mapper refuses to walk it. It becomes a
    // visible `unknown` even though it is text-less, because that node is the only remaining trace of
    // the subtree — and its label is reported, so the stop is auditable rather than silent.
    const result = mapped(
      mapEn(doc([nestUnknownContainers(17, item({ label: "text", text: "Unreachable." }))]))
    );

    expect(unitTypes(result, 0)).toEqual(["unknown"]);
    expect(result.units[0]!.docBlocks[0]!.node.attrs).toMatchObject({
      html: "",
      tag: "wrapper_16"
    });
    expect(blockTexts(result)).toEqual([""]);
    // Nothing below the bound was visited, so no deeper label is claimed to have been handled.
    expect(result.unmappedLabels).toEqual(
      Array.from({ length: 17 }, (_unused, level) => `wrapper_${level}`)
    );
  });
});

// Build a table-shaped container under `label`: docling's `_table_rows` projection is label-agnostic, so
// this is the exact shape a `table`, a `document_index`, or any future grid construct arrives in.
function tableShaped(label: string, rows: readonly (readonly StructuredDocItem[])[]) {
  return item({
    children: rows.map((cells) => item({ children: [...cells], label: "table_row" })),
    label
  });
}

// The persisted plaintext of every mapped block, concatenated — derived with the SAME function
// `blockWriter` writes to `doc_blocks.plaintext` (#312), so this is literally the text that reaches
// search, note anchors, and the reader's character stream. Deliberately NOT `blockTexts`, which also
// counts an `unknown` node's `html` attr: that attr is exactly the place text goes to be unreadable, so
// counting it would hide the loss these tests exist to catch.
function persistedPlaintext(
  result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>
): string {
  return result.units
    .flatMap((unit) => unit.docBlocks)
    .map((block) => documentText(block.node))
    .join("");
}

// Docling's table shape is label-agnostic (#859): `_table_rows` arrive under whatever label the layout
// model chose, so `canonicalBodyNode`'s default branch decides by SHAPE rather than by name. One rule
// therefore maps every table-ish construct docling emits — `document_index` above all, a book's printed
// contents and index — with no vocabulary list to maintain, while a construct with no table shape keeps
// the unchanged `unknown`/expansion path (#812).
describe("table-shaped constructs map by shape, not by label (#859)", () => {
  it("maps a table-shaped container under a label the mapper has never seen", () => {
    // The anti-rot property: nothing here names `document_index`, so a construct docling starts emitting
    // tomorrow is mapped the day it appears rather than fragmenting until someone extends a list.
    const result = mapped(
      mapEn(
        doc([
          tableShaped("some_future_grid", [
            [
              item({ label: "table_cell", text: "left" }),
              item({ label: "table_cell", text: "right" })
            ]
          ])
        ])
      )
    );

    expect(unitTypes(result, 0)).toEqual(["table"]);
    expect(persistedPlaintext(result)).toBe("leftright");
    expect(result.unmappedLabels).toEqual([]);
  });

  it("consumes every table-ish label docling nests inside the container, header cells included", () => {
    // `table_row`, `table_cell`, `row_header` and `column_header` were four of the seven labels Clean
    // Code reported as unmapped. None of them is mapped by name even now — they stop being reported
    // because the container that holds them maps, so the whole subtree is consumed as one table.
    const result = mapped(
      mapEn(
        doc([
          tableShaped("document_index", [
            [
              item({ label: "column_header", text: "Chapter" }),
              item({ label: "column_header", text: "Page" })
            ],
            [
              item({ label: "row_header", text: "Foreword" }),
              item({ label: "table_cell", text: "xix" })
            ]
          ])
        ])
      )
    );

    const table = result.units[0]!.docBlocks[0]!.node;
    expect(table.content?.map((row) => row.content?.map((cell) => cell.type))).toEqual([
      ["tableHeader", "tableHeader"],
      ["tableHeader", "tableCell"]
    ]);
    expect(persistedPlaintext(result)).toBe("ChapterPageForewordxix");
    expect(result.unmappedLabels).toEqual([]);
  });

  it("adds a table-shaped container's cell text to the persisted plaintext instead of dropping it", () => {
    // The regression guard for the tempting wrong fix. A table-shaped container carries NO text of its
    // own — every character is in its cells — so "just stop expanding table-shaped containers" emits no
    // block and loses all of it, and the pre-#859 `unknown` fallback parked it in an `html` attr that
    // never reaches `plaintext`. Both wrong shapes score zero here; only mapping the container to a
    // table carries the text through.
    const cells = ["Foreword......", "xix", "Introduction ......xxv"];
    const result = mapped(
      mapEn(
        doc([
          tableShaped("document_index", [
            [
              item({ label: "table_cell", text: cells[0]! }),
              item({ label: "table_cell", text: cells[1]! })
            ],
            [item({ label: "table_cell", text: cells[2]! })]
          ])
        ])
      )
    );

    const sourceCharacters = cells.join("").length;
    expect(persistedPlaintext(result)).toBe(cells.join(""));
    // Stated as the invariant the fix must hold, not just as the string it happens to produce: mapping
    // may re-shape a container's blocks, but it may never lose characters doing so.
    expect(persistedPlaintext(result).length).toBeGreaterThanOrEqual(sourceCharacters);
  });

  it("keeps the unknown/expansion path for a construct with no table shape", () => {
    // A loose `table_row` — cells, but no `table_row` children of its own — is not a table, so
    // `tableNode` still returns null and #812's guarantee is untouched: the container is walked into and
    // every cell survives as a visible block, with the label still reported.
    const result = mapped(
      mapEn(
        doc([
          item({
            children: [
              item({ label: "table_cell", text: "orphaned left" }),
              item({ label: "table_cell", text: "orphaned right" })
            ],
            label: "table_row"
          })
        ])
      )
    );

    expect(unitTypes(result, 0)).toEqual(["unknown", "unknown"]);
    expect(blockTexts(result)).toEqual(["orphaned left", "orphaned right"]);
    expect(result.unmappedLabels).toEqual(["table_row", "table_cell"]);
  });

  it("still reports key_value_area and form_area, the two labels that are genuinely unmapped", () => {
    // Neither is table-shaped, so neither is silenced by the shape rule. They must keep arriving through
    // the fail-loud path: that list is how an unrepresented construct stays visible instead of becoming
    // an assumption, and widening what maps must never quieten it.
    const result = mapped(
      mapEn(
        doc([
          item({ children: [item({ label: "text", text: "ISBN-13:" })], label: "key_value_area" }),
          item({ children: [item({ label: "text", text: "Signature:" })], label: "form_area" })
        ])
      )
    );

    expect(result.unmappedLabels).toEqual(["key_value_area", "form_area"]);
    // Still expanded, so their children remain readable — the shape rule changed nothing for them.
    expect(unitTypes(result, 0)).toEqual(["paragraph", "paragraph"]);
    expect(persistedPlaintext(result)).toBe("ISBN-13:Signature:");
  });
});

// The shared `needs review` policy (#763) is the SAME pure function the editor's evidence query uses, so
// asserting it here over the mapper's own output proves the two never diverge: a block's review suggestion
// is derived from the mapper's node type (`unknown` = the unknown/fallback path) and its retained
// confidence, not from a second label list duplicated in the web client.
describe("shared extraction-review policy over the mapper's output", () => {
  it("agrees with the mapper: low confidence OR the unknown/fallback path suggests review", () => {
    const result = mapped(
      mapEn(
        doc([
          item({
            confidence: PDF_EXTRACTION_CONFIDENCE_THRESHOLD - 0.25,
            label: "text",
            text: "Low"
          }),
          item({ confidence: 0.95, label: "text", text: "High" }),
          // A label with no canonical node type takes the mapper's unknown/fallback path.
          item({ confidence: 0.99, label: "sidebar", text: "Weird" })
        ])
      )
    );

    const typeById = new Map(
      result.units.flatMap((unit) => unit.docBlocks.map((block) => [block.id, block.type] as const))
    );
    const reviewByText = new Map(
      result.evidence.map((row) => {
        const unmapped = isUnmappedBlockType(typeById.get(row.blockId) ?? "");
        return [
          row.label === "sidebar" ? "Weird" : row.label,
          suggestsExtractionReview({ confidence: row.confidence, unmapped })
        ] as const;
      })
    );

    // The unknown block reached the fallback path, so the mapper reports its label as unmapped.
    expect(result.unmappedLabels).toContain("sidebar");
    const unknownRow = result.evidence.find((row) => row.label === "sidebar")!;
    expect(isUnmappedBlockType(typeById.get(unknownRow.blockId) ?? "")).toBe(true);

    // A below-threshold mapped block is suggested by confidence; a high-confidence mapped block is not;
    // the unknown block is suggested by its fallback path even though its confidence is high.
    expect(classifyExtractionConfidence(PDF_EXTRACTION_CONFIDENCE_THRESHOLD - 0.25)).toBe(
      "review-suggested"
    );
    expect(reviewByText.get("text")).toBe(false);
    expect(reviewByText.get("Weird")).toBe(true);

    const lowRow = result.evidence.find(
      (row) => row.confidence < PDF_EXTRACTION_CONFIDENCE_THRESHOLD
    )!;
    expect(
      suggestsExtractionReview({
        confidence: lowRow.confidence,
        unmapped: isUnmappedBlockType(typeById.get(lowRow.blockId) ?? "")
      })
    ).toBe(true);
  });
});

// #815: heading DEPTH comes from the PDF's own bookmark outline, not from the docling label. The fixture
// mirrors the measured reality of a real book: docling labels every heading `section_header` (measured
// `title` count across four ranges of two real books: zero), so without an outline the whole book is a
// flat wall of H2s.
describe("outline-derived heading depth", () => {
  // The real Clean Code bookmarks for pp.124-129, measured with pypdfium2 against the shipped PDF.
  const cleanCodeOutline: readonly PdfOutlineEntry[] = [
    { level: 1, pageNumber: 124, title: "Chapter 6: Objects and Data Structures" },
    { level: 2, pageNumber: 124, title: "Data Abstraction" },
    { level: 2, pageNumber: 126, title: "Data/Object Anti-Symmetry" },
    { level: 2, pageNumber: 128, title: "The Law of Demeter" },
    { level: 3, pageNumber: 129, title: "Train Wrecks" }
  ];

  // The headings docling actually emitted for that range, all with the same `section_header` label.
  const cleanCodeHeadings: readonly StructuredDocItem[] = [
    item({ label: "section_header", pageNumber: 124, text: "Objects and Data Structures" }),
    item({ label: "section_header", pageNumber: 124, text: "Data Abstraction" }),
    item({ label: "section_header", pageNumber: 126, text: "Data/Object Anti-Symmetry" }),
    item({ label: "section_header", pageNumber: 128, text: "The Law of Demeter" }),
    item({ label: "section_header", pageNumber: 129, text: "Train Wrecks" })
  ];

  const cleanCodePages: readonly StructuredPage[] = [124, 125, 126, 127, 128, 129].map(
    (pageNumber) => ({ hasNativeText: true, pageNumber })
  );

  it("derives 1/2/2/2/3 for a real book range that the label alone would flatten to all-H2", () => {
    const flat = mapped(mapEn(doc(cleanCodeHeadings, cleanCodePages)));
    expect(headingLevels(flat)).toEqual([2, 2, 2, 2, 2]);
    expect(flat.headingLevelSources).toEqual({ label: 5, outline: 0 });

    const derived = mapped(mapEn(doc(cleanCodeHeadings, cleanCodePages, cleanCodeOutline)));
    expect(headingLevels(derived)).toEqual([1, 2, 2, 2, 3]);
    expect(derived.headingLevelSources).toEqual({ label: 0, outline: 5 });
  });

  it("keeps the derived depths intact when the chapter becomes one reading unit", () => {
    // #816 changed only where units BEGIN, never the resolved depths: the same range now reads as one
    // chapter-scale unit whose sections are heading blocks inside it, at exactly the levels #815 derived.
    const derived = mapped(mapEn(doc(cleanCodeHeadings, cleanCodePages, cleanCodeOutline)));
    expect(derived.units).toHaveLength(1);
    expect(unitTypes(derived, 0)).toEqual(["heading", "heading", "heading", "heading", "heading"]);
    expect(headingLevels(derived)).toEqual([1, 2, 2, 2, 3]);
  });

  it("falls back to the label for a heading the outline does not name", () => {
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "section_header", pageNumber: 124, text: "Data Abstraction" }),
            item({ label: "section_header", pageNumber: 124, text: "Not In The Outline" }),
            item({ label: "title", pageNumber: 125, text: "Also Not In The Outline" })
          ],
          cleanCodePages,
          cleanCodeOutline
        )
      )
    );
    expect(headingLevels(result)).toEqual([2, 2, 1]);
    expect(result.headingLevelSources).toEqual({ label: 2, outline: 1 });
  });

  it("promotes a KEPT page_header that the outline names into a heading at the matched level", () => {
    // Docling routinely mislabels a chapter opener `page_header`. When the document's own outline names
    // that exact text on that exact page, the item IS the chapter heading — it starts its own unit at
    // the declared level instead of trailing along as body text.
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "text", pageNumber: 124, text: "Preamble." }),
            item({ label: "page_header", pageNumber: 124, text: "Objects and Data Structures" }),
            item({ label: "text", pageNumber: 124, text: "Chapter body." })
          ],
          cleanCodePages,
          cleanCodeOutline
        )
      )
    );
    expect(result.units).toHaveLength(2);
    expect(unitTypes(result, 0)).toEqual(["paragraph"]);
    expect(unitTypes(result, 1)).toEqual(["heading", "paragraph"]);
    expect(headingLevels(result)).toEqual([1]);
    // The promoted opener is a level-1 bookmark, so it opens a chapter titled as the publisher named it.
    expect(result.units[1]!.title).toBe("Chapter 6: Objects and Data Structures");
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 1 });
  });

  it("refuses to promote the real running heads that repeat an already-claimed bookmark", () => {
    // Measured on the real Clean Code pp.124-129 payload: docling labels the running head at the top of
    // each verso/recto `page_header`, restating the chapter or section title the page belongs to. Those
    // restatements match the SAME bookmarks the printed headings already matched. A bookmark names one
    // heading, so they must stay furniture — promoting them would duplicate every real heading in the
    // sidebar, which is worse than the flat list this issue set out to fix.
    const body: readonly StructuredDocItem[] = [
      item({ label: "section_header", pageNumber: 124, text: "Objects and Data Structures" }),
      item({ label: "section_header", pageNumber: 124, text: "Data Abstraction" }),
      item({ label: "text", pageNumber: 124, text: "Body." }),
      item({
        label: "page_header",
        pageNumber: 125,
        text: "Chapter 6: Objects and Data Structures"
      }),
      item({ label: "section_header", pageNumber: 126, text: "Data/Object Anti-Symmetry" }),
      item({ label: "page_header", pageNumber: 126, text: "Data/Object Anti-Symmetry" }),
      item({ label: "section_header", pageNumber: 128, text: "The Law of Demeter" }),
      item({ label: "page_header", pageNumber: 128, text: "The Law of Demeter" }),
      item({ label: "page_footer", pageNumber: 128, text: "97" }),
      item({ label: "section_header", pageNumber: 129, text: "Train Wrecks" })
    ];
    const result = mapped(mapEn(doc(body, cleanCodePages, cleanCodeOutline)));

    // Exactly the five printed headings, at their real declared depth — no duplicates from the four
    // furniture items.
    expect(headingLevels(result)).toEqual([1, 2, 2, 2, 3]);
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 5 });
    expect(headingTexts(result)).toEqual([
      "Objects and Data Structures",
      "Data Abstraction",
      "Data/Object Anti-Symmetry",
      "The Law of Demeter",
      "Train Wrecks"
    ]);
  });

  it("promotes a mislabelled opener whose bookmark no real heading claimed, beside claimed ones", () => {
    // The other half of the claim rule: when docling emits NO heading for a bookmark, the furniture item
    // that names it is the only candidate, so it is promoted. Ordering matters — the claimed entries are
    // resolved first, so this promotion cannot steal one of them.
    const result = mapped(
      mapEn(
        doc(
          [
            item({ label: "section_header", pageNumber: 124, text: "Data Abstraction" }),
            item({ label: "page_header", pageNumber: 124, text: "Data Abstraction" }),
            item({ label: "page_header", pageNumber: 128, text: "The Law of Demeter" }),
            item({ label: "text", pageNumber: 128, text: "Body." })
          ],
          cleanCodePages,
          cleanCodeOutline
        )
      )
    );
    expect(headingLevels(result)).toEqual([2, 2]);
    expect(result.units.map((unit) => unit.title)).toEqual([
      "Data Abstraction",
      "The Law of Demeter"
    ]);
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 2 });
  });

  it("leaves an unnamed page_header on its ordinary mapping — a label alone never promotes", () => {
    const result = mapped(
      mapEn(
        doc(
          [item({ label: "page_header", pageNumber: 124, text: "Clean Code" })],
          cleanCodePages,
          cleanCodeOutline
        )
      )
    );
    expect(unitTypes(result, 0)).not.toContain("heading");
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 0 });
  });

  it("does not promote a body paragraph even when the outline names it", () => {
    // Only heading-labelled and furniture-labelled items are candidates: a running sentence that happens
    // to repeat a bookmark title must stay a paragraph.
    const result = mapped(
      mapEn(
        doc(
          [item({ label: "text", pageNumber: 124, text: "Data Abstraction" })],
          cleanCodePages,
          cleanCodeOutline
        )
      )
    );
    expect(unitTypes(result, 0)).toEqual(["paragraph"]);
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 0 });
  });

  it("clamps an outline level deeper than the canonical model", () => {
    const result = mapped(
      mapEn(
        doc(
          [item({ label: "section_header", pageNumber: 1, text: "Very Deep" })],
          [{ hasNativeText: true, pageNumber: 1 }],
          [{ level: 9, pageNumber: 1, title: "Very Deep" }]
        )
      )
    );
    expect(headingLevels(result)).toEqual([6]);
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 1 });
  });

  it("reports an all-label document distinctly from an all-outline one", () => {
    // The counts are the falsifiable record that depth was really derived: an empty outline can never
    // report an `outline` level, so a regression that stops matching shows up here.
    const empty = mapped(mapEn(doc(cleanCodeHeadings, cleanCodePages, [])));
    expect(empty.headingLevelSources).toEqual({ label: 5, outline: 0 });
    expect(headingLevels(empty)).toEqual([2, 2, 2, 2, 2]);
  });
});

// #856: heading sanity rule. A heading whose text is a code listing (e.g., "Listing B-6 ..." followed by
// numbered source lines) is nearly always mis-extracted. Measurement over the imported corpus (#856):
// Clean Code average heading: 27 chars, legitimate max: 94 chars. DDIA max: 185 chars. A heading > 150
// chars that contains numbered lines (code pattern) is almost certainly a listing — split it into caption
// heading + code block. Fail-safe: no structural signal = keep the original heading (no magic threshold).
describe("heading sanity rule (#856): detect and split code listings absorbed into headings", () => {
  it("preserves legitimate short headings under 150 chars", () => {
    // A heading 94 chars (the measured longest legitimate heading in Clean Code) must survive unchanged.
    const shortHeading = "A".repeat(94);
    const result = mapped(
      mapEn(
        doc([
          item({ label: "section_header", text: shortHeading }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    expect(headingTexts(result)).toEqual([shortHeading]);
    expect(unitTypes(result, 0)).toEqual(["heading", "paragraph"]);
  });

  it("preserves long headings without code structure signals", () => {
    // A heading 180 chars without code patterns (no line numbers, no delimiters) keeps its form.
    // This guards against false positives: a legitimately long heading in some books must not regress.
    const longButClean =
      "This is a very long heading that exceeds 150 characters but contains " +
      "no numbered lines or code delimiters, just prose that happens to be longer than normal";
    const result = mapped(
      mapEn(
        doc([
          item({ label: "section_header", text: longButClean }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    expect(headingTexts(result)).toEqual([longButClean]);
    expect(unitTypes(result, 0)).toEqual(["heading", "paragraph"]);
  });

  it("splits a long heading containing numbered lines (code pattern) into caption + code block", () => {
    // A heading that starts with a caption then has numbered lines like a code listing is split:
    // everything before the first numbered line becomes the heading, the rest becomes a code block.
    // This models the real issue (#856): "Listing B-6 RelativeDayOfWeekRule.java 1 /* ... 2 * ..."
    const listing =
      "Listing B-6 RelativeDayOfWeekRule.java\n" +
      "1 /* =========================================\n" +
      "2  * JCommon : a free general purpose class library\n" +
      "3  * =========================================";
    const result = mapped(
      mapEn(
        doc([
          item({ label: "section_header", text: listing }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    // The listing is split: caption heading + code block + body.
    expect(unitTypes(result, 0)).toEqual(["heading", "codeBlock", "paragraph"]);
    expect(headingTexts(result)).toEqual(["Listing B-6 RelativeDayOfWeekRule.java"]);
    // The code block should contain the numbered lines.
    const codeBlock = result.units[0]!.docBlocks.find((b) => b.type === "codeBlock");
    expect(codeBlock?.node.content?.[0]?.text).toMatch(/^1 \/\*/);
  });

  it("ignores single-line headings even if long (no multiline = no code structure)", () => {
    // A single-line heading, even if 200+ chars, without newlines has no code structure signal.
    const singleLongLine = "Listing " + "A".repeat(200);
    const result = mapped(
      mapEn(
        doc([
          item({ label: "section_header", text: singleLongLine }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    expect(headingTexts(result)).toEqual([singleLongLine]);
    expect(unitTypes(result, 0)).toEqual(["heading", "paragraph"]);
  });

  it("detects various code delimiters: //, /*, {, #, etc.", () => {
    // Test that different code-start patterns are recognized: C-style //, /*, shell-style #, etc.
    // Each test case is padded with descriptive text to exceed the 150-char threshold.
    const testCases = [
      {
        name: "C++ line comment",
        text: "Listing A Sample Code with Detailed Comments and Documentation with Extended Information for Testing Purposes Only\n// This is a C++ style line comment with code"
      },
      {
        name: "C block comment",
        text: "Listing B Another Example of Code with More Context Information and Detailed Description for Extended Listing Here\n/* This is a block comment style that begins code */"
      },
      {
        name: "Shell script",
        text: "Listing C Shell Script Example with Configuration and Setup Data and More Context for Extended Listing Information\n# This is a shell-style comment introducing commands"
      },
      {
        name: "Continuation comment",
        text: "Listing D Documentation Example Showing Various Code Patterns Found Throughout Many Programs for Testing\n* This is a continuation-style comment line continuing"
      }
    ];
    for (const testCase of testCases) {
      const result = mapped(
        mapEn(
          doc([
            item({ label: "section_header", text: testCase.text }),
            item({ label: "text", text: "Body." })
          ])
        )
      );
      // Each should split into heading + code block.
      const types = unitTypes(result, 0);
      expect(types).toEqual(["heading", "codeBlock", "paragraph"]);
      const captionLine = testCase.text.split("\n")[0]!;
      expect(headingTexts(result)).toContain(captionLine);
    }
  });

  it("preserves a long heading that wraps across lines but has no code structure signal", () => {
    // A heading can legitimately span multiple lines (e.g. a subtitle wrapped during extraction)
    // without being a code listing. No line here starts with a line number or code delimiter, so the
    // heading must survive unsplit even though it is multi-line and exceeds the length threshold.
    const wrappedButClean =
      "A Very Long Chapter Heading That Somehow Wrapped Across Two Lines During Extraction\n" +
      "But Still Contains Only Ordinary Prose Text With No Code Patterns Whatsoever Present";
    const result = mapped(
      mapEn(
        doc([
          item({ label: "section_header", text: wrappedButClean }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    expect(headingTexts(result)).toEqual([wrappedButClean]);
    expect(unitTypes(result, 0)).toEqual(["heading", "paragraph"]);
  });

  it("keeps the original heading when the text before the first code line is blank", () => {
    // A stray leading blank line before the code pattern leaves no real caption text once trimmed.
    // Splitting would produce an empty heading, so the rule must fall back to the original heading
    // rather than emit a blank one.
    const blankCaptionListing =
      "\n" +
      "1 /* JCommon : a free general purpose class library for the Java platform, padded well past " +
      "the one hundred fifty character detection threshold so this line alone satisfies the rule */";
    const result = mapped(
      mapEn(
        doc([
          item({ label: "section_header", text: blankCaptionListing }),
          item({ label: "text", text: "Body." })
        ])
      )
    );
    expect(headingTexts(result)).toEqual([blankCaptionListing]);
    expect(unitTypes(result, 0)).toEqual(["heading", "paragraph"]);
  });
});

// #816: a ReadingUnit is a CHAPTER, not a heading. Measured on the real Clean Code (462pp) import:
// starting a unit at every heading produced 525 units for a book whose own bookmarks declare 27
// top-level divisions, so the reader paged through fragments. The fixtures below are the real book's
// measured bookmarks and docling headings for two chapter openers (pp.124-136 and pp.166-167), read out
// of the published import's stored range payloads.
describe("chapter-scale reading units", () => {
  const chapterPages: readonly StructuredPage[] = [
    124, 125, 126, 127, 128, 129, 130, 131, 132, 133, 134, 135, 136
  ].map((pageNumber) => ({ hasNativeText: true, pageNumber }));

  // Two adjacent real chapters: their level-1 bookmarks are the divisions; everything else is inside.
  const chapterOutline: readonly PdfOutlineEntry[] = [
    { level: 1, pageNumber: 124, title: "Chapter 6: Objects and Data Structures" },
    { level: 2, pageNumber: 124, title: "Data Abstraction" },
    { level: 2, pageNumber: 128, title: "The Law of Demeter" },
    { level: 3, pageNumber: 129, title: "Train Wrecks" },
    { level: 1, pageNumber: 134, title: "Chapter 7: Error Handling" },
    { level: 2, pageNumber: 135, title: "Use Exceptions Rather Than Return Codes" }
  ];

  const chapterBody: readonly StructuredDocItem[] = [
    item({ label: "section_header", pageNumber: 124, text: "Objects and Data Structures" }),
    item({ label: "text", pageNumber: 124, text: "Chapter six opens." }),
    item({ label: "section_header", pageNumber: 124, text: "Data Abstraction" }),
    item({ label: "text", pageNumber: 125, text: "Abstraction prose." }),
    item({ label: "section_header", pageNumber: 128, text: "The Law of Demeter" }),
    item({ label: "section_header", pageNumber: 129, text: "Train Wrecks" }),
    item({ label: "text", pageNumber: 129, text: "Train wreck prose." }),
    item({ label: "section_header", pageNumber: 134, text: "Error Handling" }),
    item({ label: "text", pageNumber: 134, text: "Chapter seven opens." }),
    item({
      label: "section_header",
      pageNumber: 135,
      text: "Use Exceptions Rather Than Return Codes"
    }),
    item({ label: "text", pageNumber: 135, text: "Exception prose." })
  ];

  // The real Chapter 10 opener: docling emitted the chapter NUMBER and its TITLE as two separate
  // headings on p166, and both resolve to the one `Chapter 10: Classes` bookmark.
  const classesOutline: readonly PdfOutlineEntry[] = [
    { level: 1, pageNumber: 166, title: "Chapter 10: Classes" },
    { level: 2, pageNumber: 167, title: "Class Organization" },
    { level: 3, pageNumber: 167, title: "Encapsulation" },
    { level: 2, pageNumber: 167, title: "Classes Should Be Small!" }
  ];

  const classesBody: readonly StructuredDocItem[] = [
    item({ label: "section_header", pageNumber: 166, text: "10" }),
    item({ label: "section_header", pageNumber: 166, text: "Classes" }),
    item({ label: "text", pageNumber: 166, text: "Chapter ten opens." }),
    item({ label: "section_header", pageNumber: 167, text: "Class Organization" }),
    item({ label: "section_header", pageNumber: 167, text: "Encapsulation" }),
    item({ label: "text", pageNumber: 167, text: "Encapsulation prose." }),
    item({ label: "section_header", pageNumber: 167, text: "Classes Should Be Small!" })
  ];

  const classesPages: readonly StructuredPage[] = [166, 167].map((pageNumber) => ({
    hasNativeText: true,
    pageNumber
  }));

  // Every mapped block, unit by unit — the invariant a boundary change is most likely to break silently.
  function blockIds(result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>): string[] {
    return result.units.flatMap((unit) => unit.docBlocks.map((block) => block.id));
  }

  it("starts a unit at each top-level bookmark and keeps the chapter's sections inside it", () => {
    const result = mapped(mapEn(doc(chapterBody, chapterPages, chapterOutline)));

    expect(result.units.map((unit) => unit.title)).toEqual([
      "Chapter 6: Objects and Data Structures",
      "Chapter 7: Error Handling"
    ]);
    // Sections stay heading BLOCKS inside their chapter rather than becoming units of their own.
    expect(unitTypes(result, 0)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "heading",
      "heading",
      "paragraph"
    ]);
    expect(unitTypes(result, 1)).toEqual(["heading", "paragraph", "heading", "paragraph"]);
    // #815's derived depths are untouched: only where units BEGIN changed.
    expect(headingLevels(result)).toEqual([1, 2, 2, 3, 1, 2]);
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 6 });
  });

  it("places every mapped block in exactly one unit", () => {
    // Each of the eleven items maps to one block, each block appears once, and every block carries
    // evidence: no block can be dropped between units or duplicated into two.
    const result = mapped(mapEn(doc(chapterBody, chapterPages, chapterOutline)));
    const ids = blockIds(result);
    expect(ids).toHaveLength(chapterBody.length);
    expect(new Set(ids).size).toBe(chapterBody.length);
    expect(result.evidence.map((row) => row.blockId)).toEqual(ids);
  });

  it("opens ONE unit when docling split the chapter opener into a number and a title", () => {
    // Measured: `10` and `Classes` are two level-1 headings resolving to the SAME bookmark. A bookmark
    // names one division, so the second joins the first's unit — 27 chapters, not 39 fragments.
    const result = mapped(mapEn(doc(classesBody, classesPages, classesOutline)));

    expect(result.units.map((unit) => unit.title)).toEqual(["Chapter 10: Classes"]);
    // The unit is titled from the bookmark, so no unit is called `10` even though its first block is.
    expect(headingTexts(result)).toEqual([
      "10",
      "Classes",
      "Class Organization",
      "Encapsulation",
      "Classes Should Be Small!"
    ]);
    expect(headingLevels(result)).toEqual([1, 1, 2, 3, 2]);
    expect(blockIds(result)).toHaveLength(classesBody.length);
  });

  it("divides an outline-less PDF at its shallowest heading level, joining a bare chapter label", () => {
    // The same range with no embedded outline: every heading falls back to its docling label (all H2),
    // so the shallowest level present divides the work — and the `10` label joins the title that names
    // it rather than becoming a unit called `10`.
    const result = mapped(mapEn(doc(classesBody, classesPages)));

    expect(result.units.map((unit) => unit.title)).toEqual([
      "10 Classes",
      "Class Organization",
      "Encapsulation",
      "Classes Should Be Small!"
    ]);
    expect(unitTypes(result, 0)).toEqual(["heading", "heading", "paragraph"]);
    expect(headingLevels(result)).toEqual([2, 2, 2, 2, 2]);
    expect(result.headingLevelSources).toEqual({ label: 5, outline: 0 });
    expect(blockIds(result)).toHaveLength(classesBody.length);
  });
});
