// The born-digital PDF fixture the #702 E2E uploads. Its bytes are the ACTUAL input the import converts:
// a PDF header, then the `%%WHETSTONE-PDF-FIXTURE%%` marker, then a valid structured RangeConversion the
// env-gated staged-fixture backend (PDF_IMPORT_FIXTURE_CONVERSION=1, set in stack.ts) reads back from the
// staged upload. This keeps the journey honest end to end — the published Work is derived from these bytes,
// not a canned server-side document — while needing no Python/Docling worker in CI. The embedded document
// is a native-text (born-digital) multi-section structure: a title, two section headers, paragraphs, a
// bullet list, and a table, so publication maps it to three ordered ReadingUnits of canonical blocks.

// Kept in sync with the runner's marker (pdfStructuredAdapter.ts). Duplicated here so the E2E loader has no
// dependency on server internals.
const FIXTURE_MARKER = "%%WHETSTONE-PDF-FIXTURE%%";
const RANGE_CONVERSION_SCHEMA_VERSION = "whetstone-pdf-structured-range/1";

type DocItem = {
  label: string;
  text: string;
  pageNumber: number;
  boundingBox: { bottom: number; left: number; right: number; top: number };
  charSpan: [number, number];
  confidence: number;
  children: DocItem[];
};

function item(partial: { label: string; text: string; children?: DocItem[] }): DocItem {
  return {
    boundingBox: { bottom: 20, left: 0, right: 100, top: 0 },
    charSpan: [0, partial.text.length],
    children: partial.children ?? [],
    confidence: 0.98,
    label: partial.label,
    pageNumber: 1,
    text: partial.text
  };
}

function listItem(text: string): DocItem {
  return item({ label: "list_item", text });
}

function tableCell(text: string, header = false): DocItem {
  return item({ label: header ? "table_header" : "table_cell", text });
}

function tableRow(cells: readonly DocItem[]): DocItem {
  return item({ children: cells as DocItem[], label: "table_row", text: "" });
}

const body: readonly DocItem[] = [
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

const conversion = {
  body,
  doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
  furniture: [],
  pages: [{ hasNativeText: true, pageNumber: 1 }],
  schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
};

export const pdfFixture = {
  buffer: Buffer.from(`%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(conversion)}`, "utf8"),
  mimeType: "application/pdf",
  name: "Multi Section Sample.pdf"
} as const;

// A fully scanned English fixture (#745): its single page carries NO native text, so the born-digital
// journey would publish nothing. The env-gated fixture OCR lane (PDF_IMPORT_FIXTURE_OCR=1, set in
// stack.ts) reads these bytes, flips the text-less page to native, and injects recovered English text —
// so after OCR the upload publishes one canonical Work whose body is the recovered text. Input-derived,
// never canned.
const scannedConversion = {
  body: [] as readonly DocItem[],
  doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
  furniture: [],
  pages: [{ hasNativeText: false, pageNumber: 1 }],
  schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
};

export const pdfScannedFixture = {
  buffer: Buffer.from(`%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(scannedConversion)}`, "utf8"),
  mimeType: "application/pdf",
  name: "Scanned English Page.pdf"
} as const;

// A mixed English fixture (#745): page 1 is born-digital (a title + paragraph with native text) and page
// 2 is scanned (text-less). OCR must preserve the native page's text and ordering while adding recovered
// English text for the scanned page, so the published Work carries both — proving mixed documents keep
// native-page content and OCR only fills the gaps.
const mixedBody: readonly DocItem[] = [
  item({ label: "title", text: "Mixed Scan Report" }),
  item({
    label: "text",
    text: "This first page is born-digital and keeps its native text through the OCR phase."
  })
];

const mixedConversion = {
  body: mixedBody,
  doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
  furniture: [],
  pages: [
    { hasNativeText: true, pageNumber: 1 },
    { hasNativeText: false, pageNumber: 2 }
  ],
  schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
};

export const pdfMixedFixture = {
  buffer: Buffer.from(`%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(mixedConversion)}`, "utf8"),
  mimeType: "application/pdf",
  name: "Mixed Scan Report.pdf"
} as const;
