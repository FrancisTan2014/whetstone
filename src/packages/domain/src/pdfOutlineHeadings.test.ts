import { describe, expect, it } from "vitest";

import {
  MAX_PDF_HEADING_LEVEL,
  matchOutlineHeading,
  normalizeOutlineTitle,
  stripHeadingNumbering,
  type PdfHeadingCandidate,
  type PdfOutlineEntry
} from "./pdfOutlineHeadings.js";

// Most cases only care about the level a match justifies; the cases that care WHICH entry was matched
// assert on `matchOutlineHeading` directly.
function levelFor(
  candidate: PdfHeadingCandidate,
  outline: readonly PdfOutlineEntry[]
): number | null {
  return matchOutlineHeading(candidate, outline)?.level ?? null;
}

// The real Clean Code bookmarks around p124-129 (measured with pypdfium2 against the shipped PDF), used
// so the ladder is exercised against the shapes a real book actually produces rather than only synthetic
// ones: a `Chapter N:`-prefixed opener, plain sibling sections, and a deeper subsection.
const cleanCodeOutline: readonly PdfOutlineEntry[] = [
  { title: "Chapter 6: Objects and Data Structures", level: 1, pageNumber: 124 },
  { title: "Data Abstraction", level: 2, pageNumber: 124 },
  { title: "Data/Object Anti-Symmetry", level: 2, pageNumber: 126 },
  { title: "The Law of Demeter", level: 2, pageNumber: 128 },
  { title: "Train Wrecks", level: 3, pageNumber: 129 }
];

describe("normalizeOutlineTitle", () => {
  it.each([
    ["collapses whitespace and lowercases", "  The   Law\nof Demeter ", "the law of demeter"],
    ["strips a decorative frame", "— Data Abstraction —", "data abstraction"],
    ["strips a trailing colon", "Data Abstraction:", "data abstraction"],
    ["keeps interior punctuation", "Data/Object Anti-Symmetry", "data/object anti-symmetry"],
    ["normalizes a non-breaking space", "Train\u00a0Wrecks", "train wrecks"],
    ["applies NFKC to full-width text", "Ｔｒａｉｎ", "train"],
    ["reduces a punctuation-only title to nothing", "— · —", ""]
  ])("%s", (_case, input, expected) => {
    expect(normalizeOutlineTitle(input)).toBe(expected);
  });
});

describe("stripHeadingNumbering", () => {
  it.each([
    ["chapter 6: objects and data structures", "objects and data structures"],
    ["chapter 6 objects and data structures", "objects and data structures"],
    ["appendix a. concurrency", "concurrency"],
    ["part i — the beginning", "the beginning"],
    ["section 12: naming", "naming"],
    ["chapter 6", ""]
  ])("strips the numbering label from %j", (input, expected) => {
    expect(stripHeadingNumbering(input)).toBe(expected);
  });

  it.each([
    ["sections of a report", "sections of a report"],
    ["chapters are long", "chapters are long"],
    ["partial evaluation", "partial evaluation"],
    ["the law of demeter", "the law of demeter"]
  ])("leaves %j untouched when it merely starts with a numbering word", (input, expected) => {
    expect(stripHeadingNumbering(input)).toBe(expected);
  });
});

describe("resolveOutlineHeadingLevel", () => {
  it.each([
    ["Data Abstraction", 124, 2, "rung 1: exact title on the same page"],
    ["  data   abstraction ", 124, 2, "rung 1: after normalization"],
    ["Objects and Data Structures", 124, 1, "rung 2: the bookmark contains the printed heading"],
    [
      "Train Wrecks",
      129,
      3,
      "rung 3 is unnecessary: an exact deeper match still wins its own rung"
    ],
    ["Chapter 6: Objects and Data Structures", 125, 1, "rung 3: numbering stripped, one page off"],
    ["Objects and Data Structures", 125, 1, "rung 3: printed heading one page after the bookmark"],
    ["The Law of Demeter", 127, 2, "rung 3: equal once neither side carries numbering"]
  ])("resolves %j on page %i to level %i (%s)", (text, pageNumber, expected) => {
    expect(levelFor({ pageNumber, text }, cleanCodeOutline)).toBe(expected);
  });

  it.each([
    ["Something Never Bookmarked", 124, "no entry names it"],
    ["Data Abstraction", 400, "the same title is too far from its bookmark"],
    ["Data Abstraction", 126, "two pages away is outside the proximity window"],
    ["", 124, "a blank heading carries no evidence"],
    ["   ", 124, "a whitespace-only heading carries no evidence"],
    ["— —", 124, "a punctuation-only heading normalizes to nothing"]
  ])("returns null for %j on page %i (%s)", (text, pageNumber) => {
    expect(levelFor({ pageNumber, text }, cleanCodeOutline)).toBeNull();
  });

  it("returns null against an empty outline", () => {
    expect(levelFor({ pageNumber: 1, text: "Anything" }, [])).toBeNull();
  });

  it("prefers the SHALLOWEST level when several entries tie on the same rung", () => {
    const outline: readonly PdfOutlineEntry[] = [
      { title: "Conclusion", level: 4, pageNumber: 10 },
      { title: "Conclusion", level: 2, pageNumber: 10 },
      { title: "Conclusion", level: 3, pageNumber: 10 }
    ];
    expect(levelFor({ pageNumber: 10, text: "Conclusion" }, outline)).toBe(2);
  });

  it("stops at the FIRST matching rung even when a shallower entry matches a later rung", () => {
    const outline: readonly PdfOutlineEntry[] = [
      // Rung 1 hit: exact title on the page, at level 3.
      { title: "Naming", level: 3, pageNumber: 20 },
      // Would win rung 3 (numbering stripped, adjacent page) with a shallower level — but rung 1 fired.
      { title: "Chapter 2: Naming", level: 1, pageNumber: 21 }
    ];
    expect(levelFor({ pageNumber: 20, text: "Naming" }, outline)).toBe(3);
  });

  it("prefers a same-page containment match over an adjacent-page numbering match", () => {
    const outline: readonly PdfOutlineEntry[] = [
      { title: "Chapter 2: Naming Things Well", level: 2, pageNumber: 20 },
      { title: "Chapter 2: Naming", level: 1, pageNumber: 21 }
    ];
    expect(levelFor({ pageNumber: 20, text: "Naming" }, outline)).toBe(2);
  });

  it("clamps a level deeper than the canonical model to the deepest heading", () => {
    const outline: readonly PdfOutlineEntry[] = [
      { title: "Deeply Nested", level: 9, pageNumber: 5 }
    ];
    expect(levelFor({ pageNumber: 5, text: "Deeply Nested" }, outline)).toBe(MAX_PDF_HEADING_LEVEL);
  });

  it("never matches a bookmark whose numbering strips it to nothing", () => {
    // Both sides strip to "", which would otherwise compare equal and hand out a bogus level.
    const outline: readonly PdfOutlineEntry[] = [{ title: "Chapter 7", level: 1, pageNumber: 40 }];
    expect(levelFor({ pageNumber: 41, text: "Chapter 8" }, outline)).toBeNull();
  });

  it("matches the whole Clean Code p124-129 range to its declared 1/2/2/2/3 depth", () => {
    const printedHeadings = [
      { pageNumber: 124, text: "Objects and Data Structures" },
      { pageNumber: 124, text: "Data Abstraction" },
      { pageNumber: 126, text: "Data/Object Anti-Symmetry" },
      { pageNumber: 128, text: "The Law of Demeter" },
      { pageNumber: 129, text: "Train Wrecks" }
    ];
    expect(printedHeadings.map((heading) => levelFor(heading, cleanCodeOutline))).toEqual([
      1, 2, 2, 2, 3
    ]);
  });

  it("reports WHICH entry was matched, so a caller can tell two claimants apart", () => {
    // The printed chapter heading and the running head that repeats it on the next page resolve to the
    // SAME bookmark. A bookmark names one heading, so the caller needs the entry's identity to refuse the
    // second claimant rather than emitting a duplicate heading beside the real one.
    expect(
      matchOutlineHeading(
        { pageNumber: 124, text: "Objects and Data Structures" },
        cleanCodeOutline
      )
    ).toEqual({ entryIndex: 0, level: 1 });
    expect(
      matchOutlineHeading(
        { pageNumber: 125, text: "Chapter 6: Objects and Data Structures" },
        cleanCodeOutline
      )
    ).toEqual({ entryIndex: 0, level: 1 });
    expect(
      matchOutlineHeading({ pageNumber: 129, text: "Train Wrecks" }, cleanCodeOutline)
    ).toEqual({ entryIndex: 4, level: 3 });
  });

  it("keeps the FIRST entry when several tie on the shallowest level", () => {
    const outline: readonly PdfOutlineEntry[] = [
      { title: "Conclusion", level: 3, pageNumber: 10 },
      { title: "Conclusion", level: 2, pageNumber: 10 },
      { title: "Conclusion", level: 2, pageNumber: 10 }
    ];
    expect(matchOutlineHeading({ pageNumber: 10, text: "Conclusion" }, outline)).toEqual({
      entryIndex: 1,
      level: 2
    });
  });
});
