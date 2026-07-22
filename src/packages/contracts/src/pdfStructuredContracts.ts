import { z } from "zod";

// The validated, versioned structured-document contract the PDF adapter emits (#701). This is
// whetstone's OWN projection of docling-core's DoclingDocument, not Markdown and not the docling
// objects themselves: format-specific detail ends here, so a later canonicalization step (#702) reads
// one stable, validated shape instead of parsing converter output or Markdown as a second truth.
//
// Layout order, headings, tables, and figures are fallible EVIDENCE, so every item keeps its raw
// `label`, its geometry/provenance, and an explicit `confidence`; nothing is coerced into a
// known-type enum and nothing low-confidence is dropped. Native-text availability is reported per
// page so #702 can atomically reject an incomplete image document and #704 can later pick exactly
// which pages need OCR.

// Our contract versions. `parse*` validate the exact version and reject anything else so an
// incompatible converter is a named failure, not a silent misread.
export const STRUCTURED_DOCUMENT_SCHEMA_VERSION = "whetstone-pdf-structured/1";
export const RANGE_CONVERSION_SCHEMA_VERSION = "whetstone-pdf-structured-range/1";

// The docling-core DoclingDocument schema version(s) this adapter understands. Pinned in lockstep
// with the docling-core version the setup step installs and verifies (scripts/setup/steps/pdf.mjs):
// docling-core 2.87.1 emits DoclingDocument schema "1.10.0". An emitted version outside this set is a
// named `unsupported_schema` failure, never a silent misread.
export const SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS: readonly string[] = Object.freeze(["1.10.0"]);

// The exact runtime the real lane requires. Setup installs and verifies these exact versions before
// reporting readiness; the adapter records the schema version it validated for provenance. Kept in
// lockstep with scripts/setup/steps/pdf.mjs (which cannot import this TS module).
export const PINNED_DOCLING_VERSION = "2.114.0";
export const PINNED_DOCLING_CORE_VERSION = "2.87.1";
// The pinned Docling layout/table model artifacts. Docling downloads these from the HF repo below at
// this exact revision; setup verifies the pinned runtime can construct its converter (i.e. the model
// set at this revision is present) before reporting readiness, so a silently different model set
// fails readiness rather than degrading extraction quietly.
export const PINNED_MODEL_REPO = "docling-project/docling-models";
export const PINNED_MODEL_REVISION = "v2.3.0";

// Resource bounds. Enforced before and around conversion so an oversized or absurd input is a named
// failure rather than an unbounded child process. Mirrors PRODUCT.md's 128 MiB / 3,000-page limits.
export const MAX_STAGED_BYTES = 128 * 1024 * 1024;
export const MAX_PAGE_COUNT = 3000;

export type BoundingBox = Readonly<{ left: number; top: number; right: number; bottom: number }>;

export interface StructuredDocItem {
  // The raw docling label (e.g. "section_header", "table", "picture", "formula", or an unknown one).
  // Kept verbatim — never narrowed to an enum — so an unrecognized item is preserved, not dropped.
  readonly label: string;
  readonly pageNumber: number;
  readonly boundingBox: BoundingBox;
  // [start, end] character offsets of this item's text within its page's projected plaintext.
  readonly charSpan: readonly [number, number];
  // Extraction confidence in [0, 1]. Low confidence is retained as evidence, never a drop reason.
  readonly confidence: number;
  readonly text: string;
  readonly children: readonly StructuredDocItem[];
}

export type StructuredPage = Readonly<{ pageNumber: number; hasNativeText: boolean }>;

export type StructuredDocumentSource = Readonly<{
  sha256: string;
  byteLength: number;
  pageCount: number;
}>;

export type DoclingSchemaRef = Readonly<{ name: string; version: string }>;

export type StructuredDocument = Readonly<{
  schemaVersion: typeof STRUCTURED_DOCUMENT_SCHEMA_VERSION;
  doclingSchema: DoclingSchemaRef;
  source: StructuredDocumentSource;
  pages: readonly StructuredPage[];
  body: readonly StructuredDocItem[];
  furniture: readonly StructuredDocItem[];
}>;

// One page range's worth of converted structure, as emitted by the worker. It carries no source hash
// or total page count (the adapter owns those); the adapter concatenates ranges in source order and
// adds the source metadata to form the final StructuredDocument.
export type RangeConversion = Readonly<{
  schemaVersion: typeof RANGE_CONVERSION_SCHEMA_VERSION;
  doclingSchema: DoclingSchemaRef;
  pages: readonly StructuredPage[];
  body: readonly StructuredDocItem[];
  furniture: readonly StructuredDocItem[];
}>;

const boundingBoxSchema = z
  .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
  .strict();

const docItemSchema: z.ZodType<StructuredDocItem> = z.lazy(() =>
  z
    .object({
      label: z.string().min(1),
      pageNumber: z.number().int().positive(),
      boundingBox: boundingBoxSchema,
      charSpan: z
        .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
        .refine(([start, end]) => start <= end, { message: "charSpan start must be <= end." }),
      confidence: z.number().min(0).max(1),
      text: z.string(),
      children: z.array(docItemSchema)
    })
    .strict()
);

const pageSchema = z
  .object({ pageNumber: z.number().int().positive(), hasNativeText: z.boolean() })
  .strict();

const doclingSchemaRefSchema = z
  .object({ name: z.string().min(1), version: z.string().min(1) })
  .strict();

const sourceSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex characters."),
    byteLength: z.number().int().nonnegative(),
    pageCount: z.number().int().nonnegative()
  })
  .strict();

const rangeConversionSchema = z
  .object({
    schemaVersion: z.literal(RANGE_CONVERSION_SCHEMA_VERSION),
    doclingSchema: doclingSchemaRefSchema,
    pages: z.array(pageSchema),
    body: z.array(docItemSchema),
    furniture: z.array(docItemSchema)
  })
  .strict();

const structuredDocumentSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_DOCUMENT_SCHEMA_VERSION),
    doclingSchema: doclingSchemaRefSchema,
    source: sourceSchema,
    pages: z.array(pageSchema),
    body: z.array(docItemSchema),
    furniture: z.array(docItemSchema)
  })
  .strict();

export function isSupportedDoclingSchemaVersion(version: string): boolean {
  return SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS.includes(version);
}

export type ParseRangeResult =
  | Readonly<{ status: "ok"; value: RangeConversion }>
  | Readonly<{ status: "malformed"; detail: string }>
  | Readonly<{ status: "unsupported_schema"; version: string }>;

// Validate one worker range payload from its raw stdout string. A JSON/shape error is `malformed`; a
// well-formed payload whose docling-core schema version is not pinned is `unsupported_schema`
// (distinct so the caller can point at setup rather than blame the file). The version is checked
// before the full parse so an unknown schema is reported as such even when its item shapes differ.
export function parseRangeConversion(raw: string): ParseRangeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { status: "malformed", detail: (cause as SyntaxError).message };
  }

  const declaredVersion = readDoclingSchemaVersion(json);
  if (declaredVersion !== null && !isSupportedDoclingSchemaVersion(declaredVersion)) {
    return { status: "unsupported_schema", version: declaredVersion };
  }

  const parsed = rangeConversionSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "malformed", detail: parsed.error.issues[0]!.message };
  }
  return { status: "ok", value: parsed.data };
}

function readDoclingSchemaVersion(json: unknown): string | null {
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const schema = (json as { doclingSchema?: unknown }).doclingSchema;
  if (typeof schema !== "object" || schema === null) {
    return null;
  }
  const version = (schema as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

export type ProbeParseResult =
  | Readonly<{ status: "ok"; pageCount: number }>
  | Readonly<{ status: "malformed"; detail: string }>;

// Validate the worker's `--probe` stdout into a page count. A JSON error, a missing/non-integer/
// negative page count, is `malformed` so the adapter reports a named failure instead of trusting a
// bad number. Extracted as a pure function so the real spawn boundary stays a thin, ignored wrapper.
export function parseProbePageCount(raw: string): ProbeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { status: "malformed", detail: (cause as SyntaxError).message };
  }
  const pageCount = (json as { pageCount?: unknown } | null)?.pageCount;
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 0) {
    return { status: "malformed", detail: "probe did not report a non-negative integer page count." };
  }
  return { status: "ok", pageCount };
}

export type ValidateStructuredResult =
  | Readonly<{ ok: true; document: StructuredDocument }>
  | Readonly<{ ok: false; detail: string }>;

// Validate a fully assembled structured document (the shape a consumer receives). Used by the
// contract suite as the shared oracle both the fake and the real adapter must satisfy.
export function validateStructuredDocument(value: unknown): ValidateStructuredResult {
  const parsed = structuredDocumentSchema.safeParse(value);
  return parsed.success
    ? { ok: true, document: parsed.data }
    : { ok: false, detail: parsed.error.issues[0]!.message };
}

// Concatenate validated ranges in source order into one structured document, attaching the adapter's
// source metadata. Body and furniture items keep their given order (ranges already arrive in page
// order); pages are ordered by page number. Trusts already-validated ranges — it does not re-reject.
export function concatenateRanges(
  source: StructuredDocumentSource,
  ranges: readonly RangeConversion[]
): StructuredDocument {
  const doclingSchema = ranges[0]?.doclingSchema ?? {
    name: "DoclingDocument",
    version: SUPPORTED_DOCLING_CORE_SCHEMA_VERSIONS[0]!
  };
  const pages = ranges
    .flatMap((range) => range.pages)
    .slice()
    .sort((left, right) => left.pageNumber - right.pageNumber);

  return Object.freeze({
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    doclingSchema,
    source,
    pages,
    body: ranges.flatMap((range) => range.body),
    furniture: ranges.flatMap((range) => range.furniture)
  });
}

// Depth-first flatten of an item tree, parents before children, preserving order. Lets a consumer
// (and the contract suite) confirm nothing was dropped and low-confidence items survived.
export function flattenDocItems(items: readonly StructuredDocItem[]): readonly StructuredDocItem[] {
  return items.flatMap((item) => [item, ...flattenDocItems(item.children)]);
}
