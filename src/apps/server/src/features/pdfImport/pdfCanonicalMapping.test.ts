import type {
  PdfOutlineEntry,
  StructuredDocItem,
  StructuredDocument,
  StructuredPage
} from "@whetstone/contracts";
import { STRUCTURED_DOCUMENT_SCHEMA_VERSION } from "@whetstone/contracts";
import { parseDocument, type DocumentNodeJSON } from "@whetstone/document";
import {
  buildHeadingOutline,
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
    label: partial.label,
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
    // Each heading starts its own unit.
    expect(result.units).toHaveLength(2);
    const title = result.units[0]!.docBlocks[0]!.node;
    const section = result.units[1]!.docBlocks[0]!.node;
    expect(title.type).toBe("heading");
    expect((title.attrs as { level: number }).level).toBe(1);
    expect((section.attrs as { level: number }).level).toBe(2);
    expect(result.units[0]!.title).toBe("The Work");
    expect(result.units[1]!.title).toBe("First Section");
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

  function headingLevels(
    result: Extract<PdfCanonicalMappingResult, { status: "mapped" }>
  ): number[] {
    return result.units
      .map((unit) => unit.docBlocks[0]!.node)
      .filter((node) => node.type === "heading")
      .map((node) => (node.attrs as { level: number }).level);
  }

  it("derives 1/2/2/2/3 for a real book range that the label alone would flatten to all-H2", () => {
    const flat = mapped(mapEn(doc(cleanCodeHeadings, cleanCodePages)));
    expect(headingLevels(flat)).toEqual([2, 2, 2, 2, 2]);
    expect(flat.headingLevelSources).toEqual({ label: 5, outline: 0 });

    const derived = mapped(mapEn(doc(cleanCodeHeadings, cleanCodePages, cleanCodeOutline)));
    expect(headingLevels(derived)).toEqual([1, 2, 2, 2, 3]);
    expect(derived.headingLevelSources).toEqual({ label: 0, outline: 5 });
  });

  it("turns the same units into a NESTED reader outline with no Reader change", () => {
    // `buildHeadingOutline` already nests by heading level, so correct levels alone convert the flat
    // sidebar into Chapter -> Section. This asserts that end to end over the mapper's own output.
    function outlineDepths(document: StructuredDocument): number[] {
      const result = mapped(mapEn(document));
      return buildHeadingOutline(
        result.units.map((unit, index) => {
          const node = unit.docBlocks[0]!.node;
          const level =
            node.type === "heading" ? (node.attrs as { level: number }).level : undefined;
          return {
            entryId: `u${index}`,
            ...(level === undefined ? {} : { headingLevel: level }),
            ...(unit.title === undefined ? {} : { title: unit.title })
          };
        })
      ).map((entry) => entry.depth);
    }

    expect(outlineDepths(doc(cleanCodeHeadings, cleanCodePages))).toEqual([0, 0, 0, 0, 0]);
    expect(outlineDepths(doc(cleanCodeHeadings, cleanCodePages, cleanCodeOutline))).toEqual([
      0, 1, 1, 1, 2
    ]);
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
    expect(result.units[1]!.title).toBe("Objects and Data Structures");
    expect(result.headingLevelSources).toEqual({ label: 0, outline: 1 });
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
