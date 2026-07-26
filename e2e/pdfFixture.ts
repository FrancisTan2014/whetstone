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

// Fully scanned Chinese fixtures (#746): like the English scanned fixture, each single page carries NO
// native text, so the recovered text is supplied entirely by the fixture OCR lane in the language the
// pass is asked to recognize. The learner selects the scanned-text language (the pre-import OCR override)
// before starting, so these bytes publish Simplified- or Traditional-Chinese recovered text — proving the
// override drives OCR independently of the Work language. Distinct names/titles keep search unambiguous.
// Each fixture also embeds its own `metadata.title`, so the two scanned documents carry DISTINCT bytes —
// exactly as two real scanned PDFs would — and neither the content-addressed source store nor any OCR
// staging collapses them onto one shared result when both are imported in the same run.
function scannedFixture(name: string) {
  const scanned = {
    body: [] as readonly DocItem[],
    doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
    furniture: [],
    metadata: { author: null, title: name },
    pages: [{ hasNativeText: false, pageNumber: 1 }],
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
  };
  return {
    buffer: Buffer.from(`%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(scanned)}`, "utf8"),
    mimeType: "application/pdf",
    name: `${name}.pdf`
  } as const;
}

export const pdfScannedChineseSimplifiedFixture = scannedFixture("Scanned Simplified Chinese Page");
export const pdfScannedChineseTraditionalFixture = scannedFixture(
  "Scanned Traditional Chinese Page"
);

// Review-boundary fixtures (#750). The PDF review E2E needs, per conversion lane, TWO uploads that share
// the confirm-form title (so the second trips the same-title candidate) but carry DIFFERENT bytes (so the
// second is a fuzzy edition, not an exact re-upload). Both filenames in a lane are identical, so the confirm
// form pre-fills the SAME title from the stem; the embedded document differs only in body/marker text, which
// changes the source hash without changing the resolved title (the entered title wins). Distinct probe names
// keep these Works isolated from the #702/#745 specs on the shared smoke DB — no title or exact-source
// collision. The original publishes as a new Work; re-uploading its exact bytes reopens it; the edition's
// different bytes route through the shared duplicate-review panel.
function bornDigitalReviewFixture(fileName: string, title: string, paragraph: string) {
  const conversion = {
    body: [item({ label: "title", text: title }), item({ label: "text", text: paragraph })],
    doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
    furniture: [],
    pages: [{ hasNativeText: true, pageNumber: 1 }],
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
  };
  return {
    buffer: Buffer.from(`%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(conversion)}`, "utf8"),
    mimeType: "application/pdf",
    name: fileName
  } as const;
}

const BORN_DIGITAL_REVIEW_FILE = "PDF Review Born Digital 750.pdf";
export const pdfReviewBornDigitalOriginalFixture = bornDigitalReviewFixture(
  BORN_DIGITAL_REVIEW_FILE,
  "Born-Digital Review Original",
  "The original born-digital edition body proving the #750 review boundary."
);
export const pdfReviewBornDigitalEditionFixture = bornDigitalReviewFixture(
  BORN_DIGITAL_REVIEW_FILE,
  "Born-Digital Review Edition",
  "A distinct born-digital edition body whose different bytes trip a fuzzy #750 candidate."
);

// Scanned-English review fixtures: like #745's scanned lane, each page carries NO native text, so the
// env-gated fixture OCR lane recovers the same English text for both. The embedded metadata marker only
// varies the bytes (the entered title wins), so the two share a title yet hash differently.
function scannedReviewFixture(fileName: string, marker: string) {
  const conversion = {
    body: [] as readonly DocItem[],
    doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
    furniture: [],
    metadata: { author: null, title: marker },
    pages: [{ hasNativeText: false, pageNumber: 1 }],
    schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
  };
  return {
    buffer: Buffer.from(`%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(conversion)}`, "utf8"),
    mimeType: "application/pdf",
    name: fileName
  } as const;
}

const SCANNED_REVIEW_FILE = "PDF Review Scanned 750.pdf";
export const pdfReviewScannedOriginalFixture = scannedReviewFixture(
  SCANNED_REVIEW_FILE,
  "review-scanned-original"
);
export const pdfReviewScannedEditionFixture = scannedReviewFixture(
  SCANNED_REVIEW_FILE,
  "review-scanned-edition"
);

// A mixed-confidence born-digital fixture for the extraction-evidence correction E2E (#763). One paragraph
// carries a below-threshold extractor confidence (so the published block is review-suggested and cued),
// while the title and the other paragraph are high-confidence (not cued). Publication persists each item's
// confidence to `pdf_block_evidence`, so the correction editor can guide an administrator to the one block
// the extractor was least sure about, then clear only that block's cue once it is corrected.
function evidenceItem(text: string, confidence: number, label = "text"): DocItem {
  return { ...item({ label, text }), confidence };
}

const evidenceBody: readonly DocItem[] = [
  evidenceItem("Extraction Evidence Sample", 0.98, "title"),
  evidenceItem("This paragraph mapped cleanly with high extractor confidence.", 0.98),
  evidenceItem("This paragraph mapped with low extractor confidence.", 0.4)
];

const evidenceConversion = {
  body: evidenceBody,
  doclingSchema: { name: "DoclingDocument", version: "1.10.0" },
  furniture: [],
  pages: [{ hasNativeText: true, pageNumber: 1 }],
  schemaVersion: RANGE_CONVERSION_SCHEMA_VERSION
};

export const pdfExtractionEvidenceFixture = {
  buffer: Buffer.from(
    `%PDF-1.7\n${FIXTURE_MARKER}\n${JSON.stringify(evidenceConversion)}`,
    "utf8"
  ),
  mimeType: "application/pdf",
  name: "Extraction Evidence Sample.pdf"
} as const;
