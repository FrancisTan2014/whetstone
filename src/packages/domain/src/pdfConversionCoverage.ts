// The second, INDEPENDENT completeness invariant for a converted PDF (#832).
//
// The worker's own status check is the PRIMARY defence and is strictly stronger than this one: docling
// keeps going when individual pages fail and returns a document holding only the pages that survived, so
// a range whose reported status is not an unqualified success is refused in the child before a payload
// exists — a `PARTIAL_SUCCESS` carrying per-page `std::bad_alloc` errors is refused on that signal alone,
// whatever this module concludes. That check trusts the converter to tell the truth. This one does not:
// it re-derives completeness from the payload the converter actually produced, so a converter that
// reports SUCCESS while silently under-producing — a future version, a different backend, a bug — is
// still caught before a fragment is published as a whole book. It is the backstop, never the substitute.
//
// THE RULE (`PRODUCT.md` → "v0 content ingestion"; `docs/DECISIONS.md` D7). A page the extractor itself
// reported as carrying native text must be ACCOUNTED FOR: it contributes a body item, or everything the
// converter recognised on it was page furniture — an item in either group, at any depth. A page that
// yielded literally nothing, neither body nor furniture, while the source says it has text, is counted as
// lost: the converter never produced that page.
//
// WHY FURNITURE COUNTS, AND WHY THAT IS NOT A HOLE. A real book has pages whose only native text is
// furniture — a part-divider verso carrying just a running head, an intentionally blank page the
// typesetter still numbered, a full-page plate whose only text is its caption and folio. Requiring a
// *body* item would refuse a correct conversion of a healthy book, which is a worse defect than the one
// this fixes: today a truncated book is published silently; a body-only rule would reject sound books
// wholesale. Accounting for furniture-only pages is not a loophole but the point — a numbered blank page
// and a page dropped by a failed conversion are different events, and only the second is a defect. The
// distinction that matters is not "did this page produce readable prose" but "did the
// converter process this page at all", and an item in either group is proof that it did. Where the item
// lands is a LAYOUT classification made after the page converted, and dropping running heads from the
// readable hierarchy (#811) is a readability decision taken later still, in the mapper, over this same
// raw payload — so a page whose only contribution is later excluded as furniture still satisfies this
// invariant. Conflating the two would turn a furniture rule into a conversion refusal.
//
// This does NOT make the invariant vacuous. The observed defect — 45 of 50 pages lost to per-page
// allocation failures — produces pages with no item of any kind, because those pages were never
// processed; they are still caught, and every dropped page is still reported.
//
// KNOWN RESIDUAL. `hasNativeText` is `count_chars() > 0` over the page's text layer, which counts
// whitespace, so a page whose text layer holds only blank glyphs claims native text yet can legitimately
// yield no recognized item. Such a page is refused here. That is deliberate: the refusal is visible,
// names truncation, and creates no Work, whereas the failure it guards against is invisible and reaches
// the learner as a book that is quietly 9% complete. Narrowing it further needs per-page evidence the
// payload does not carry today (a page-processed marker from the converter), which is a contract change
// beyond this fix.
//
// Pure and dependency-free: no React, Fastify, database, fs, or env config. The parameter types are
// structural on purpose, so the validated `@whetstone/contracts` `StructuredPage` / `StructuredDocItem`
// satisfy them without this module depending on the transport contract.

// One page as the extractor classified it: whether its text layer yielded characters.
export type PdfConversionCoveragePage = Readonly<{ pageNumber: number; hasNativeText: boolean }>;

// One converted item. The groups are TREES — docling nests items inside groups, lists, and tables, and a
// page's only contribution is frequently a nested child — so a page is covered by an item at ANY depth.
export type PdfConversionCoverageItem = Readonly<{
  pageNumber: number;
  children?: readonly PdfConversionCoverageItem[] | undefined;
}>;

// Everything the converter recognized, in the two groups the payload carries. Both are named explicitly
// rather than passed as one flat list so a caller cannot silently omit furniture and re-create the
// body-only rule that would refuse a healthy book.
export type PdfConversionRecognizedItems = Readonly<{
  body: readonly PdfConversionCoverageItem[];
  furniture: readonly PdfConversionCoverageItem[];
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

// The pages that reported native text but contributed NO recognized item of any kind, ascending. An empty
// result means the payload accounts for every page the extractor said had text.
export function findPagesMissingConvertedContent(
  pages: readonly PdfConversionCoveragePage[],
  recognized: PdfConversionRecognizedItems
): readonly number[] {
  const covered = new Set<number>();
  collectCoveredPages(recognized.body, covered);
  collectCoveredPages(recognized.furniture, covered);
  return pages
    .filter((page) => page.hasNativeText && !covered.has(page.pageNumber))
    .map((page) => page.pageNumber)
    .sort((left, right) => left - right);
}
