// The second, INDEPENDENT completeness invariant for a converted PDF (#832).
//
// The worker's own status check is the primary defence: docling keeps going when individual pages fail
// and returns a document holding only the pages that survived, so a range whose reported status is not an
// unqualified success is refused in the child before a payload exists. That check trusts the converter to
// tell the truth. This one does not: it re-derives completeness from the payload the converter actually
// produced, so a converter that reports SUCCESS while dropping pages — a future version, a different
// backend, a bug — is still caught before a fragment is published as a whole book.
//
// The invariant is the weakest claim that catches the observed defect: a page the extractor itself
// reported as carrying native text must contribute at least one body item. It never asserts how MUCH a
// page produced (a legitimately sparse page is normal) and it says nothing about a page with no native
// text — that page is already the OCR-validation path's business.
//
// Pure and dependency-free: no React, Fastify, database, fs, or env config. The parameter types are
// structural on purpose, so the validated `@whetstone/contracts` `StructuredPage` / `StructuredDocItem`
// satisfy them without this module depending on the transport contract.

// One page as the extractor classified it: whether its text layer yielded characters.
export type PdfConversionCoveragePage = Readonly<{ pageNumber: number; hasNativeText: boolean }>;

// One converted body item. The body is a TREE — docling nests items inside groups, lists, and tables, and
// a page's only contribution is frequently a nested child — so a page is covered by an item at ANY depth.
export type PdfConversionCoverageItem = Readonly<{
  pageNumber: number;
  children?: readonly PdfConversionCoverageItem[] | undefined;
}>;

function collectCoveredPages(
  items: readonly PdfConversionCoverageItem[],
  covered: Set<number>
): void {
  for (const item of items) {
    covered.add(item.pageNumber);
    collectCoveredPages(item.children ?? [], covered);
  }
}

// The pages that reported native text but contributed NO body item, ascending. An empty result means the
// payload covers every page the extractor said had text.
//
// The RAW body is the right input, before page furniture is excluded (#811): a page whose only item is a
// running head was still converted, so removing it later is a readability decision, not evidence that the
// converter dropped the page. Conflating the two would turn a furniture rule into a conversion refusal.
export function findPagesMissingBodyContent(
  pages: readonly PdfConversionCoveragePage[],
  body: readonly PdfConversionCoverageItem[]
): readonly number[] {
  const covered = new Set<number>();
  collectCoveredPages(body, covered);
  return pages
    .filter((page) => page.hasNativeText && !covered.has(page.pageNumber))
    .map((page) => page.pageNumber)
    .sort((left, right) => left - right);
}
