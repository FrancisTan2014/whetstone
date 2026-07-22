import {
  RANGE_CONVERSION_SCHEMA_VERSION,
  type RangeConversion,
  type StructuredDocItem
} from "@whetstone/contracts";

// The deterministic born-digital preview document (#702). Until the real Docling runner lands (an opt-in
// later issue), the keyless conversion lane cannot read a learner's actual bytes, so every queued attempt
// converts to this one canned, native-text, multi-section structured result. It exercises the full
// canonical mapping — a work title, two sections, paragraphs, a bullet list, and a table — so an uploaded
// PDF publishes a real Author -> Work -> ReadingUnit -> Block Work that opens in the existing Reader. The
// support copy names this the born-digital preview; #705 replaces both the fake runner and this sample
// with measured real conversion.

const doclingSchema = { name: "DoclingDocument", version: "1.10.0" } as const;

function item(
  partial: Partial<StructuredDocItem> & { label: string; text: string }
): StructuredDocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, partial.text.length],
    children: [],
    confidence: 0.98,
    pageNumber: 1,
    ...partial
  };
}

function listItem(text: string): StructuredDocItem {
  return item({ label: "list_item", text });
}

function tableCell(text: string, header = false): StructuredDocItem {
  return item({ label: header ? "table_header" : "table_cell", text });
}

function tableRow(cells: readonly StructuredDocItem[]): StructuredDocItem {
  return item({ children: cells as StructuredDocItem[], label: "table_row", text: "" });
}

const sampleBody: readonly StructuredDocItem[] = [
  item({ label: "title", text: "Born-Digital Preview" }),
  item({
    label: "text",
    text: "This preview Work is produced from your uploaded PDF through the canonical block pipeline."
  }),
  item({ label: "section_header", text: "How Import Works" }),
  item({
    label: "text",
    text: "Every source format terminates at the same ProseMirror Work, ReadingUnit, and Block hierarchy."
  }),
  item({
    children: [
      listItem("Structure and geometry are retained only as ingestion evidence."),
      listItem("The Reader, search, and notes consume ordinary canonical blocks."),
      listItem("No Markdown conversion or page viewer is involved.")
    ],
    label: "unordered_list",
    text: ""
  }),
  item({ label: "section_header", text: "What Remains" }),
  item({
    label: "text",
    text: "OCR, correction tooling, and corpus calibration are still pending in later issues."
  }),
  item({
    children: [
      tableRow([tableCell("Capability", true), tableCell("Status", true)]),
      tableRow([tableCell("Born-digital import"), tableCell("Available now")]),
      tableRow([tableCell("Scanned OCR"), tableCell("Coming soon")])
    ],
    label: "table",
    text: ""
  })
];

const sampleDocument: RangeConversion = {
  body: sampleBody as StructuredDocItem[],
  doclingSchema,
  furniture: [],
  pages: [{ hasNativeText: true, pageNumber: 1 }],
  schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
};

// The serialized range payload the keyless fake runner returns for any queued attempt.
export const bornDigitalPreviewRangePayload: string = JSON.stringify(sampleDocument);
