import { describe, expect, it } from "vitest";

import {
  findPagesMissingConvertedContent,
  type PdfConversionCoverageItem,
  type PdfConversionCoveragePage
} from "./pdfConversionCoverage";

function page(pageNumber: number, hasNativeText = true): PdfConversionCoveragePage {
  return { hasNativeText, pageNumber };
}

function onPage(
  pageNumber: number,
  children: readonly PdfConversionCoverageItem[] = []
): PdfConversionCoverageItem {
  return { children, pageNumber };
}

// The payload always carries both groups, so every case states both — the rule is about what the
// converter recognized, not about where the layout classifier filed it.
function recognized(
  body: readonly PdfConversionCoverageItem[],
  furniture: readonly PdfConversionCoverageItem[] = []
): { body: readonly PdfConversionCoverageItem[]; furniture: readonly PdfConversionCoverageItem[] } {
  return { body, furniture };
}

describe("findPagesMissingConvertedContent", () => {
  it("reports nothing when every native-text page contributed a body item", () => {
    const pages = [page(1), page(2), page(3)];
    expect(
      findPagesMissingConvertedContent(pages, recognized([onPage(1), onPage(2), onPage(3)]))
    ).toEqual([]);
  });

  it("reports the pages that contributed no item at all, ascending", () => {
    const pages = [page(1), page(2), page(3), page(4)];
    expect(findPagesMissingConvertedContent(pages, recognized([onPage(3), onPage(1)]))).toEqual([
      2, 4
    ]);
  });

  // The observed defect, at its observed scale: docling dropped 45 of 50 pages to per-page allocation
  // failures and returned only the 5 that survived. Every lost page must be named.
  it("refuses a decimated payload and reports every one of the 45 lost pages", () => {
    const survived = [151, 152, 164, 176, 187];
    const pages = Array.from({ length: 50 }, (_, index) => page(150 + index));
    const missing = findPagesMissingConvertedContent(
      pages,
      recognized(survived.map((pageNumber) => onPage(pageNumber)))
    );
    expect(missing).toHaveLength(45);
    expect(missing).not.toContain(151);
    expect(missing).toContain(150);
    expect(missing).toContain(199);
    expect([...missing].sort((left, right) => left - right)).toEqual(missing);
  });

  // A REAL BOOK, healthy: a part-divider verso whose only text is a running head, an intentionally blank
  // page the typesetter still numbered, and a full-page plate whose only text is its caption. Each page
  // converted; requiring a *body* item on every page would refuse the whole sound book.
  it("accepts a healthy book whose pages carry only furniture", () => {
    const pages = [page(1), page(2), page(3), page(4)];
    const body = [
      onPage(1), // chapter prose
      onPage(3) // the plate's caption
    ];
    const furniture = [
      onPage(2), // part-divider verso: a running head and nothing else
      onPage(4) // numbered blank page: a folio and nothing else
    ];
    expect(findPagesMissingConvertedContent(pages, recognized(body, furniture))).toEqual([]);
  });

  // Docling emits running heads INSIDE `doc.body` (its own `furniture` group is deprecated and arrives
  // empty), and #811 excludes them later, in the mapper, over this same raw payload. Either placement is
  // proof the page converted, so both must satisfy the invariant.
  it("accepts a furniture-only page whichever group the converter filed it in", () => {
    const pages = [page(1), page(2)];
    const inBody = findPagesMissingConvertedContent(pages, recognized([onPage(1), onPage(2)], []));
    const inFurniture = findPagesMissingConvertedContent(
      pages,
      recognized([onPage(1)], [onPage(2)])
    );
    expect(inBody).toEqual([]);
    expect(inFurniture).toEqual(inBody);
  });

  // The failure signal the rule is built on: not "produced no prose" but "produced nothing whatsoever".
  it("refuses a native-text page that yielded neither body nor furniture", () => {
    const pages = [page(1), page(2), page(3)];
    const body = [onPage(1)];
    const furniture = [onPage(3)];
    expect(findPagesMissingConvertedContent(pages, recognized(body, furniture))).toEqual([2]);
  });

  it("counts a nested child as covering its page, at any depth", () => {
    const pages = [page(1), page(2), page(3)];
    const body = [onPage(1, [onPage(2, [onPage(3)])])];
    expect(findPagesMissingConvertedContent(pages, recognized(body))).toEqual([]);
  });

  it("counts a nested furniture child too", () => {
    const pages = [page(1), page(2)];
    expect(
      findPagesMissingConvertedContent(pages, recognized([onPage(1)], [onPage(1, [onPage(2)])]))
    ).toEqual([]);
  });

  it("ignores a page with no native text — that page is the OCR path's business", () => {
    const pages = [page(1), page(2, false), page(3, false)];
    expect(findPagesMissingConvertedContent(pages, recognized([onPage(1)]))).toEqual([]);
  });

  it("reports every native-text page when the payload recognized nothing", () => {
    const pages = [page(1), page(2)];
    expect(findPagesMissingConvertedContent(pages, recognized([]))).toEqual([1, 2]);
  });

  it("reports nothing for a document with no pages", () => {
    expect(findPagesMissingConvertedContent([], recognized([onPage(1)]))).toEqual([]);
  });

  it("tolerates an item whose children are absent rather than empty", () => {
    const pages = [page(1), page(2)];
    const body: readonly PdfConversionCoverageItem[] = [{ pageNumber: 1 }, { pageNumber: 2 }];
    expect(findPagesMissingConvertedContent(pages, recognized(body))).toEqual([]);
  });

  it("ignores an item on a page the document never declared", () => {
    const pages = [page(1)];
    expect(findPagesMissingConvertedContent(pages, recognized([onPage(1), onPage(99)]))).toEqual(
      []
    );
  });
});
