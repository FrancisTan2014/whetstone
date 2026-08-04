import { describe, expect, it } from "vitest";

import {
  findPagesMissingBodyContent,
  type PdfConversionCoverageItem,
  type PdfConversionCoveragePage
} from "./pdfConversionCoverage.js";

function page(pageNumber: number, hasNativeText = true): PdfConversionCoveragePage {
  return { hasNativeText, pageNumber };
}

function item(
  pageNumber: number,
  children: readonly PdfConversionCoverageItem[] = []
): PdfConversionCoverageItem {
  return { children, pageNumber };
}

describe("findPagesMissingBodyContent", () => {
  it("reports nothing when every native-text page contributed an item", () => {
    expect(findPagesMissingBodyContent([page(1), page(2)], [item(1), item(2)])).toEqual([]);
  });

  it("reports the native-text pages that contributed no item at all", () => {
    // The observed defect (#832): docling dropped most pages of the range and returned a document
    // holding only the survivors, so the payload covers a fraction of the pages it claims.
    const pages = [page(1), page(2), page(3), page(4)];
    expect(findPagesMissingBodyContent(pages, [item(3)])).toEqual([1, 2, 4]);
  });

  it("counts a page whose only contribution is nested inside another item", () => {
    // The body is a tree: a page's sole item is frequently a list item or table cell several levels
    // down. Walking only the top level would report a fully-converted page as lost.
    const body = [item(1, [item(2, [item(3)])])];
    expect(findPagesMissingBodyContent([page(1), page(2), page(3)], body)).toEqual([]);
  });

  it("ignores an item's page when the item declares no children key", () => {
    const body: readonly PdfConversionCoverageItem[] = [{ pageNumber: 1 }, { pageNumber: 2 }];
    expect(findPagesMissingBodyContent([page(1), page(2)], body)).toEqual([]);
  });

  it("says nothing about a page with no native text", () => {
    // A text-less page is the OCR-validation path's business; it is not evidence the converter dropped
    // anything, so this invariant must not double-report it.
    expect(findPagesMissingBodyContent([page(1, false), page(2)], [item(2)])).toEqual([]);
  });

  it("reports every native-text page when the body is empty", () => {
    expect(findPagesMissingBodyContent([page(2), page(1)], [])).toEqual([1, 2]);
  });

  it("returns the missing pages in ascending order regardless of the reported page order", () => {
    const pages = [page(9), page(3), page(7)];
    expect(findPagesMissingBodyContent(pages, [])).toEqual([3, 7, 9]);
  });

  it("ignores a body item on a page the document never reported", () => {
    // A stray item cannot vouch for a page that does not exist, and must not mask a real loss.
    expect(findPagesMissingBodyContent([page(1)], [item(42)])).toEqual([1]);
  });
});
