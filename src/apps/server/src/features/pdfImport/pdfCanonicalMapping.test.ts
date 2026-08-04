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

// A real payload's page list and its body describe the SAME converted range, so a fixture's default page
// list is derived from the pages its body items actually occupy. Before #832 the default was a fixed page
// 1, which silently modelled a range that reported native text on a page it never converted — exactly the
// loss mapping now refuses. Tests about page coverage, OCR routing, or page counts pass `pages` explicitly.
function nativePages(...pageNumbers: readonly number[]): readonly StructuredPage[] {
  return pageNumbers.map((pageNumber) => ({ hasNativeText: true, pageNumber }));
}

function pagesCoveringBody(body: readonly StructuredDocItem[]): readonly StructuredPage[] {
  const pageNumbers = new Set<number>();
  const visit = (items: readonly StructuredDocItem[]): void => {
    for (const entry of items) {
      pageNumbers.add(entry.pageNumber);
      visit(entry.children);
    }
  };
  visit(body);
  if (pageNumbers.size === 0) {
    return [{ hasNativeText: true, pageNumber: 1 }];
  }
  return [...pageNumbers]
    .sort((left, right) => left - right)
    .map((pageNumber) => ({ hasNativeText: true, pageNumber }));
}

function doc(
  body: readonly StructuredDocItem[],
  pages: readonly StructuredPage[] = pagesCoveringBody(body),
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

  it("still reports a body that converted nothing anywhere as no_content, not incomplete", () => {
    // A payload that produced NO items extracted nothing anywhere, which the payload alone cannot tell
    // apart from a genuinely contentless PDF — that is the long-standing `no_content` refusal, and the
    // worker's own status check is what catches a range docling dropped entirely. Both create no Work.
    const pages = [
      { hasNativeText: true, pageNumber: 1 },
      { hasNativeText: true, pageNumber: 2 }
    ];
    expect(mapEn(doc([], pages))).toEqual({ status: "no_content" });
  });

  it("refuses a SUCCESS payload whose native-text pages produced no items as incomplete_conversion", () => {
    // #832's independent invariant: the converter reported these pages as carrying native text, so a
    // payload covering only page 1 means pages 2 and 3 were silently DROPPED. Publishing that fragment
    // as a whole book is the defect being fixed, so the whole document is refused and the number of
    // lost pages is reported — never a partial Work, never a warning.
    const pages = [
      { hasNativeText: true, pageNumber: 1 },
      { hasNativeText: true, pageNumber: 2 },
      { hasNativeText: true, pageNumber: 3 }
    ];
    const result = mapEn(doc([item({ label: "text", text: "only page one survived" })], pages));
    expect(result).toEqual({ pagesMissingContent: 2, status: "incomplete_conversion" });
  });

  it("accepts a document whose pages are all covered by nested body items", () => {
    // A page whose only contribution is a nested list item is fully converted; the invariant walks the
    // whole tree, so it must not refuse a healthy document.
    const pages = [
      { hasNativeText: true, pageNumber: 1 },
      { hasNativeText: true, pageNumber: 2 }
    ];
    const body = [
      item({
        children: [item({ label: "list_item", pageNumber: 2, text: "nested on page two" })],
        label: "list",
        text: ""
      })
    ];
    expect(mapped(mapEn(doc(body, pages))).units.length).toBeGreaterThan(0);
  });

  it("does not treat an excluded-furniture page as a dropped page", () => {
    // Page furniture (#811) is removed for READABILITY after this check; a page whose only item is a
    // running head was still converted, so the two rules must not be conflated into a false refusal.
    const pages = [
      { hasNativeText: true, pageNumber: 1 },
      { hasNativeText: true, pageNumber: 2 }
    ];
    const body = [
      item({ label: "text", pageNumber: 1, text: "real content" }),
      item({ label: "page_header", pageNumber: 2, text: "12" })
    ];
    const result = mapEn(doc(body, pages));
    expect(result.status).toBe("mapped");
  });

  it("accepts a page whose only item the converter filed in the furniture group", () => {
    // The payload carries TWO groups and the invariant must read both. Docling files running heads in
    // `doc.body` today, but `doc.furniture` is a first-class part of the validated contract, and a
    // healthy book's part-divider verso or numbered blank page may contribute only there. Reading the
    // body alone would refuse that sound book — so this asserts the mapping passes furniture through.
    const pages = [
      { hasNativeText: true, pageNumber: 1 },
      { hasNativeText: true, pageNumber: 2 }
    ];
    const document = {
      ...doc([item({ label: "text", pageNumber: 1, text: "real content" })], pages),
      furniture: [item({ label: "page_header", pageNumber: 2, text: "Chapter 5" })]
    };
    expect(mapEn(document).status).toBe("mapped");
  });

  it("refuses text-less pages before it looks at conversion coverage", () => {
    // A text-less page is the OCR path's business. Reporting it as a dropped page instead would send
    // the learner to the wrong remedy.
    //
    // This fixture is built to DISCRIMINATE, which is harder than it looks. `findPagesMissingConvertedContent`
    // already filters on `hasNativeText`, and an empty body short-circuits the coverage computation to zero,
    // so a document that is merely text-less cannot tell the two orderings apart — swap the guards and it
    // still reports OCR. The orderings diverge only for a document carrying BOTH signals at once: a
    // text-less page (page 1) AND a native-text page that produced nothing (page 3), with a non-empty body
    // (page 2) so the coverage check actually runs. OCR-first reports `ocr_validation_failed`;
    // coverage-first would report `incomplete_conversion`. Verified to bite by temporarily swapping the two
    // guards in `mapStructuredDocument` and confirming this test — and only this one — fails.
    const pages = [
      { hasNativeText: false, pageNumber: 1 },
      { hasNativeText: true, pageNumber: 2 },
      { hasNativeText: true, pageNumber: 3 }
    ];
    const body = [item({ label: "text", pageNumber: 2, text: "the one page that converted" })];
    expect(mapEn(doc(body, pages))).toEqual({
      pagesNeedingOcr: 1,
      status: "ocr_validation_failed"
    });
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
  it("excludes folios and running heads from the body and reports them as evidence", () => {
    const result = mapped(
      mapEn(
        doc([
          item({ label: "page_header", pageNumber: 1, text: "Chapter 5: Formatting" }),
          item({ label: "page_footer", pageNumber: 1, text: "\u2014 89 \u2014" }),
          item({ label: "text", pageNumber: 1, text: "Readable prose." }),
          item({ label: "page_header", pageNumber: 2, text: "Chapter 5: Formatting" }),
          item({ label: "page_footer", pageNumber: 2, text: "90" }),
          item({ label: "text", pageNumber: 2, text: "More prose." })
        ])
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
        doc([
          item({ label: "page_header", pageNumber: 1, text: "Clean Code" }),
          item({ label: "text", pageNumber: 1, text: "Range one prose." }),
          item({ label: "page_header", pageNumber: 3, text: "Clean Code" }),
          item({ label: "text", pageNumber: 3, text: "Range two prose." })
        ])
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
        doc([
          item({ label: "page_header", pageNumber: 2, text: "The Law of Demeter" }),
          item({ label: "section_header", pageNumber: 2, text: "The Law of Demeter" }),
          item({ label: "text", pageNumber: 2, text: "Prose." })
        ])
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
        doc([
          item({ label: "page_header", pageNumber: 1, text: "Chapter 3: Functions" }),
          item({ label: "text", pageNumber: 1, text: "Prose." }),
          item({ label: "page_footer", pageNumber: 2, text: "1. [Martin]." })
        ])
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
        doc([
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
        ])
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
      doc([
        item({ label: "page_header", pageNumber: 1, text: "Clean Code" }),
        item({ label: "page_footer", pageNumber: 1, text: "12" }),
        item({ label: "page_header", pageNumber: 2, text: "Clean Code" }),
        item({ label: "page_footer", pageNumber: 2, text: "13" })
      ])
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

  // The pages that fixture body occupies. The real range is pp.124-129, but the fixture deliberately
  // carries only the headings docling emitted — the prose on 125 and 127 is irrelevant to heading depth —
  // so the declared page list matches the fixture's own body rather than claiming native text on pages
  // this document never supplies content for (#832 refuses exactly that shape). Tests below that carry a
  // smaller body likewise declare only the pages they converted.
  const cleanCodePages = nativePages(124, 126, 128, 129);

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
          nativePages(124, 125),
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
          nativePages(124),
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
    expect(result.units.map((unit) => unit.title)).toEqual([
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
          nativePages(124, 128),
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
          nativePages(124),
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
          nativePages(124),
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
