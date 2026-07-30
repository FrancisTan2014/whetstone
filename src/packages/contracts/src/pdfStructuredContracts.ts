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
// The pinned Docling layout/table model artifacts. We pin the IMMUTABLE commit SHA, never the mutable
// `v2.3.0` Git/Hugging Face tag: a tag can be moved to different artifacts and still pass readiness,
// so setup downloads and verifies this EXACT commit. `PINNED_MODEL_TAG` is the human-readable label
// the commit resolved from (for changelogs/upgrades only) — it is never used as the download revision.
// Bump the commit SHA and the tag note together if the model set is intentionally changed.
export const PINNED_MODEL_REPO = "docling-project/docling-models";
export const PINNED_MODEL_TAG = "v2.3.0";
export const PINNED_MODEL_COMMIT = "fc0f2d45e2218ea24bce5045f58a389aed16dc23";

// Resource bounds. Enforced before and around conversion so an oversized or absurd input is a named
// failure rather than an unbounded child process. Mirrors PRODUCT.md's 128 MiB / 3,000-page limits.
export const MAX_STAGED_BYTES = 128 * 1024 * 1024;
export const MAX_PAGE_COUNT = 3000;

export type BoundingBox = Readonly<{ left: number; top: number; right: number; bottom: number }>;

// A manifest reference to ONE rendered picture the worker extracted to a server-owned artifact file
// (#807). It carries only metadata — never the bytes: a root-relative `path` inside the range artifact
// directory, the fixed `image/png` content type, the SHA-256 of the exact PNG bytes (the content-address
// the ImageResourceStore later stores under), the byte length, and the pixel dimensions. The server
// validates every field against the file on disk (path stays inside the root, digest/length/dimensions
// match) before adopting it; an over-bound or unrenderable picture carries no ref and falls back to the
// #806 unresolved-placeholder path.
export type PdfImageArtifactRef = Readonly<{
  path: string;
  contentType: "image/png";
  sha256: string;
  byteLength: number;
  width: number;
  height: number;
}>;

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
  // For a picture/figure item whose image the worker could render (#807): the manifest ref to its
  // extracted PNG artifact. Absent for every non-picture item and for a picture the worker could not
  // render or that exceeded the per-picture size bound (which stays a #806 placeholder).
  readonly imageArtifact?: PdfImageArtifactRef | undefined;
}

export type StructuredPage = Readonly<{ pageNumber: number; hasNativeText: boolean }>;

// Cleaned document-level bibliographic metadata (#702): the PDF's own Title/Author from its info
// dictionary, trimmed with empty values normalized to null by the worker. Consumed as the MIDDLE layer
// of publication's title/author resolution ladder — entered value first, then this cleaned PDF metadata,
// then the filename stem. Optional because a born-digital PDF may carry none.
export type StructuredDocumentMetadata = Readonly<{
  title: string | null;
  author: string | null;
}>;

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
  // Cleaned PDF document metadata, when the source carried any; absent otherwise. Explicit `| undefined`
  // to match the Zod `.optional()` inference under `exactOptionalPropertyTypes`.
  metadata?: StructuredDocumentMetadata | undefined;
}>;

// One page range's worth of converted structure, as emitted by the worker. It carries no source hash
// or total page count (the adapter owns those); the adapter concatenates ranges in source order and
// adds the source metadata to form the final StructuredDocument. Each range may carry the document's
// cleaned bibliographic metadata (the worker reads it per invocation); the adapter surfaces the first
// non-empty title/author across ranges.
export type RangeConversion = Readonly<{
  schemaVersion: typeof RANGE_CONVERSION_SCHEMA_VERSION;
  doclingSchema: DoclingSchemaRef;
  pages: readonly StructuredPage[];
  body: readonly StructuredDocItem[];
  furniture: readonly StructuredDocItem[];
  metadata?: StructuredDocumentMetadata | undefined;
}>;

const boundingBoxSchema = z
  .object({ left: z.number(), top: z.number(), right: z.number(), bottom: z.number() })
  .strict();

// One rendered-picture artifact manifest ref (#807). `sha256` is a lowercase hex SHA-256 digest; the
// server re-verifies it (and the length/dimensions) against the file before adoption, so an untrusted or
// tampered ref cannot smuggle a wrong-size or wrong-content image into publication.
const imageArtifactSchema = z
  .object({
    path: z.string().min(1),
    contentType: z.literal("image/png"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters."),
    byteLength: z.number().int().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive()
  })
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
      children: z.array(docItemSchema),
      imageArtifact: imageArtifactSchema.optional()
    })
    .strict()
);

const pageSchema = z
  .object({ pageNumber: z.number().int().positive(), hasNativeText: z.boolean() })
  .strict();

// Cleaned document metadata: nullable title/author, both present (the worker emits explicit nulls when
// a field is absent). Optional on the range/document envelope so an older or metadata-less payload is
// still valid.
const documentMetadataSchema = z
  .object({ title: z.string().nullable(), author: z.string().nullable() })
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
    furniture: z.array(docItemSchema),
    metadata: documentMetadataSchema.optional()
  })
  .strict();

const structuredDocumentSchema = z
  .object({
    schemaVersion: z.literal(STRUCTURED_DOCUMENT_SCHEMA_VERSION),
    doclingSchema: doclingSchemaRefSchema,
    source: sourceSchema,
    pages: z.array(pageSchema),
    body: z.array(docItemSchema),
    furniture: z.array(docItemSchema),
    metadata: documentMetadataSchema.optional()
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

// The quarter-turn page rotations a PDF page may declare, in degrees. A probe that reports anything
// else is malformed — OCR's geometry validator (#704) compares rotation exactly, so a nonsense value
// must never reach it.
export const SUPPORTED_PAGE_ROTATIONS: readonly number[] = Object.freeze([0, 90, 180, 270]);

// One page's lightweight classification, reported by the shared adapter's `--probe` BEFORE any full
// Docling conversion (#744): its box dimensions (PDF points) and quarter-turn rotation, plus whether
// the page already carries native text. This is the SOLE classifier #704 routes on — a scanned/mixed
// document is detected here, so it never pays for a disposable pre-OCR Docling conversion.
export type ProbePage = Readonly<{
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
  hasNativeText: boolean;
}>;

const probePageSchema = z
  .object({
    pageNumber: z.number().int().positive(),
    width: z.number().finite().nonnegative(),
    height: z.number().finite().nonnegative(),
    rotation: z
      .number()
      .int()
      .refine((value) => SUPPORTED_PAGE_ROTATIONS.includes(value), {
        message: "rotation must be one of 0, 90, 180, 270 degrees."
      }),
    hasNativeText: z.boolean()
  })
  .strict();

const probeClassificationSchema = z
  .object({ pageCount: z.number().int().nonnegative(), pages: z.array(probePageSchema) })
  .strict()
  .superRefine((value, ctx) => {
    if (value.pages.length !== value.pageCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `probe reported ${value.pageCount} pages but ${value.pages.length} page records.`
      });
      return;
    }
    const seen = new Set<number>();
    for (const page of value.pages) {
      if (page.pageNumber > value.pageCount || seen.has(page.pageNumber)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `probe page numbers must be unique and within 1..${value.pageCount}.`
        });
        return;
      }
      seen.add(page.pageNumber);
    }
  });

export type ProbeParseResult =
  | Readonly<{ status: "ok"; pageCount: number; pages: readonly ProbePage[] }>
  | Readonly<{ status: "malformed"; detail: string }>;

// Validate the worker's `--probe` stdout into a page count AND per-page geometry/rotation/native-text
// classification. A JSON error, a missing/non-integer/negative page count, a page-count/records
// mismatch, an out-of-range or duplicate page number, a negative dimension, or an unsupported rotation
// is `malformed` so the adapter reports a named failure instead of trusting a bad classifier. Extracted
// as a pure function so the real spawn boundary stays a thin, ignored wrapper.
export function parseProbeClassification(raw: string): ProbeParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    return { status: "malformed", detail: (cause as SyntaxError).message };
  }
  const parsed = probeClassificationSchema.safeParse(json);
  if (!parsed.success) {
    return { status: "malformed", detail: parsed.error.issues[0]!.message };
  }
  return { status: "ok", pageCount: parsed.data.pageCount, pages: parsed.data.pages };
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

// Resolve the document's cleaned metadata from its ranges: the first non-null title and the first
// non-null author seen in range order (the worker emits the same document metadata on every range, so
// this simply tolerates a metadata-less range). Returns undefined when no range carried either value,
// keeping the field truly optional on the assembled document.
function resolveDocumentMetadata(
  ranges: readonly RangeConversion[]
): StructuredDocumentMetadata | undefined {
  let title: string | null = null;
  let author: string | null = null;
  for (const range of ranges) {
    if (title === null && range.metadata?.title != null) {
      title = range.metadata.title;
    }
    if (author === null && range.metadata?.author != null) {
      author = range.metadata.author;
    }
  }
  return title === null && author === null ? undefined : { author, title };
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

  const metadata = resolveDocumentMetadata(ranges);
  return Object.freeze({
    schemaVersion: STRUCTURED_DOCUMENT_SCHEMA_VERSION,
    doclingSchema,
    source,
    pages,
    body: ranges.flatMap((range) => range.body),
    furniture: ranges.flatMap((range) => range.furniture),
    ...(metadata ? { metadata } : {})
  });
}

// Depth-first flatten of an item tree, parents before children, preserving order. Lets a consumer
// (and the contract suite) confirm nothing was dropped and low-confidence items survived.
export function flattenDocItems(items: readonly StructuredDocItem[]): readonly StructuredDocItem[] {
  return items.flatMap((item) => [item, ...flattenDocItems(item.children)]);
}
