// Pure OCR ingestion decisions for scanned/mixed PDFs (#704). OCR is language-aware ingestion
// preprocessing that produces evidence for the SAME structured PDF adapter (#701) and publishes
// through the SAME atomic canonical commit (#702); it never becomes a derived Reader source. This
// module owns only the decisions that can be made without a subprocess, fs, or DB, so the server
// runner/publisher can trust them and test them in isolation:
//   - which Tesseract language(s) to OCR a Work in, chosen explicitly from the Work language;
//   - which pages actually need OCR (only pages a validated conversion classified as text-less, so a
//     mixed document keeps its native pages untouched and a born-digital document is never rewritten);
//   - whether an OCR pass preserved the invariants that make its output safe to re-ingest — page
//     count, per-page box geometry, rotation, and previously-native page text.

import type { WorkLanguage } from "./work.js";

// The exact Tesseract `-l` value for each Work language. Chosen explicitly from the Work language
// (never guessed from page content): English OCRs as `eng`; Chinese variants pair the script model
// with `eng` so embedded Latin (URLs, code, loanwords) still resolves. These strings are a product
// requirement (issue acceptance), not a style token, so they are asserted directly by tests.
const tesseractLanguageByWorkLanguage: Readonly<Record<WorkLanguage, string>> = {
  en: "eng",
  "zh-CN": "chi_sim+eng",
  "zh-TW": "chi_tra+eng"
};

// The individual Tesseract trained-data packs each Work language requires, so setup/doctor can verify
// the EXACT packs are installed (not merely that the binary exists) and name any missing one. Derived
// from the same source of truth as the `-l` value by splitting on `+`.
const traineddataByWorkLanguage: Readonly<Record<WorkLanguage, readonly string[]>> = {
  en: Object.freeze(["eng"]),
  "zh-CN": Object.freeze(["chi_sim", "eng"]),
  "zh-TW": Object.freeze(["chi_tra", "eng"])
};

// Should the runner execute an OCR pre-pass for this document? Only when the source has text-less pages
// (a `scanned` or `mixed` routing). A `native` (born-digital) document is never rewritten. Every v0
// Work language now ships an OCR pack (#746), so the pass is gated only by the routing kind; a language
// whose pack is not installed still fails visibly and per-import at the adapter's runtime pack check.
export function ocrPassRequired(kind: OcrRoutingKind): boolean {
  return kind !== "native";
}

// The Tesseract `-l` value to OCR a Work in.
export function ocrTesseractLanguage(language: WorkLanguage): string {
  return tesseractLanguageByWorkLanguage[language];
}

// The exact Tesseract trained-data packs required for a Work language (for setup/doctor verification).
export function requiredTesseractTraineddata(language: WorkLanguage): readonly string[] {
  return traineddataByWorkLanguage[language];
}

// Resolve the language an OCR pass runs in: an explicit override chosen before starting wins, otherwise
// the Work's own language. Both are drawn from the same three-value Work-language set, so the resolved
// value always maps to a known pack set — there is no free-text OCR language.
export function resolveOcrLanguage(
  workLanguage: WorkLanguage,
  override: WorkLanguage | null
): WorkLanguage {
  return override ?? workLanguage;
}

export type OcrPageClassification = Readonly<{ pageNumber: number; hasNativeText: boolean }>;

// `native`  — every page already has usable native text; no OCR pass is needed (a born-digital PDF is
//             never rewritten).
// `scanned` — no page has native text; the whole document is OCR'd.
// `mixed`   — some pages have native text and some do not; only the text-less pages are OCR'd and the
//             native pages (and their ordering) are preserved.
export type OcrRoutingKind = "native" | "scanned" | "mixed";

export type OcrRoutingDecision = Readonly<{
  kind: OcrRoutingKind;
  // The page numbers lacking native text, ascending and de-duplicated. Empty exactly when `native`.
  pageNumbersNeedingOcr: readonly number[];
  nativePageCount: number;
  ocrPageCount: number;
}>;

// Decide, from a validated conversion's per-page native-text classification, which pages need OCR.
// This reuses #701's classification rather than inventing a second detector: a page needs OCR exactly
// when the adapter reported it has no native text. Pure and total — the caller (server runner) uses it
// to skip OCR entirely for a born-digital document and to report scanned/mixed counts.
export function classifyOcrRouting(pages: readonly OcrPageClassification[]): OcrRoutingDecision {
  // Collapse to one decision per page number before counting, so duplicate classifications for the same
  // page can never inflate the counts (raw `pages.length` would report a phantom native page and mislabel
  // a duplicated text-less page as `mixed` instead of `scanned`). A page counts as native only when every
  // classification of it reports native text; if duplicate classifications for a page disagree, OCR wins,
  // because `--skip-text` preserves any native text while skipping a scanned page would lose content.
  const needsOcrByPage = new Map<number, boolean>();
  for (const page of pages) {
    needsOcrByPage.set(
      page.pageNumber,
      (needsOcrByPage.get(page.pageNumber) ?? false) || !page.hasNativeText
    );
  }

  const pageNumbersNeedingOcr = Array.from(needsOcrByPage.entries())
    .filter(([, needsOcr]) => needsOcr)
    .map(([pageNumber]) => pageNumber)
    .sort((left, right) => left - right);

  const ocrPageCount = pageNumbersNeedingOcr.length;
  const nativePageCount = needsOcrByPage.size - ocrPageCount;

  const kind: OcrRoutingKind =
    ocrPageCount === 0 ? "native" : nativePageCount === 0 ? "scanned" : "mixed";

  return Object.freeze({
    kind,
    nativePageCount,
    ocrPageCount,
    pageNumbersNeedingOcr: Object.freeze(pageNumbersNeedingOcr)
  });
}

// Per-page geometry that an OCR pass must not alter: the page's box dimensions and its rotation. OCR
// only adds an invisible text layer, so a change here means the output is not a faithful overlay of the
// original and must be rejected before it is re-ingested.
export type OcrPageGeometry = Readonly<{
  pageNumber: number;
  width: number;
  height: number;
  rotation: number;
}>;

// Documented tolerance (in PDF points) for a page box dimension. OCRmyPDF may nudge a box by a sub-point
// amount when it rewrites the page; anything beyond this is treated as a real geometry change.
export const OCR_GEOMETRY_TOLERANCE_PT = 1;

export type OcrGeometryValidation =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      reason: "page_count_changed" | "page_missing" | "dimensions_changed" | "rotation_changed";
      detail: string;
    }>;

// Verify an OCR pass preserved page count, per-page box geometry, and rotation within tolerance. Pages
// are matched by page number (not array position) so an accidental reorder surfaces as a missing page
// rather than a silent mismatch. Rotation must match exactly; dimensions must match within tolerance.
export function validateOcrGeometry(
  before: readonly OcrPageGeometry[],
  after: readonly OcrPageGeometry[],
  options?: Readonly<{ tolerancePt?: number }>
): OcrGeometryValidation {
  if (before.length !== after.length) {
    return Object.freeze({
      ok: false,
      reason: "page_count_changed",
      detail: `expected ${before.length} pages, OCR output has ${after.length}.`
    });
  }

  const tolerance = options?.tolerancePt ?? OCR_GEOMETRY_TOLERANCE_PT;
  const afterByPage = new Map(after.map((page) => [page.pageNumber, page]));

  for (const original of before) {
    const ocred = afterByPage.get(original.pageNumber);
    if (ocred === undefined) {
      return Object.freeze({
        ok: false,
        reason: "page_missing",
        detail: `OCR output is missing page ${original.pageNumber}.`
      });
    }
    if (
      Math.abs(ocred.width - original.width) > tolerance ||
      Math.abs(ocred.height - original.height) > tolerance
    ) {
      return Object.freeze({
        ok: false,
        reason: "dimensions_changed",
        detail: `page ${original.pageNumber} box changed beyond ${tolerance}pt tolerance.`
      });
    }
    if (ocred.rotation !== original.rotation) {
      return Object.freeze({
        ok: false,
        reason: "rotation_changed",
        detail: `page ${original.pageNumber} rotation changed from ${original.rotation} to ${ocred.rotation}.`
      });
    }
  }

  return Object.freeze({ ok: true });
}

export type NativeTextValidation =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; pageNumber: number }>;

// Verify a `--skip-text` OCR pass left every already-native page's text intact: a page that had native
// text before the pass must still report native text after. If a native page comes back text-less the
// pass corrupted it, so re-ingestion must be refused. Pages present only after the pass are ignored
// here (their content is new OCR text, validated as ordinary low-confidence blocks downstream).
export function validateNativeTextPreserved(
  before: readonly OcrPageClassification[],
  after: readonly OcrPageClassification[]
): NativeTextValidation {
  const afterByPage = new Map(after.map((page) => [page.pageNumber, page.hasNativeText]));
  for (const page of before) {
    if (page.hasNativeText && afterByPage.get(page.pageNumber) !== true) {
      return Object.freeze({ ok: false, pageNumber: page.pageNumber });
    }
  }
  return Object.freeze({ ok: true });
}
