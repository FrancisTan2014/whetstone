import { describe, expect, it } from "vitest";

import {
  decidePdfReadingUnits,
  type PdfReadingUnitHeading,
  type PdfReadingUnitStart
} from "./pdfReadingUnits.js";

// A block that is not a heading. Most blocks in a real book are these, and they simply belong to the unit
// they fall inside.
const BODY = null;

// A heading the docling label alone leveled (#815's last-resort fallback): no bookmark named it.
function labelled(level: number, text: string): PdfReadingUnitHeading {
  return { level, outlineEntry: null, text };
}

// A heading a bookmark named: `index` identifies WHICH bookmark, so the two halves of one opener (`10`
// then `Classes`) carry the same index, exactly as the matcher resolves them on the real book.
function authored(
  level: number,
  index: number,
  title: string,
  text = title
): PdfReadingUnitHeading {
  return { level, outlineEntry: { index, title }, text };
}

// The property the Reader depends on and the one most likely to break silently: the starts partition the
// block list — ascending, beginning at block 0 — so slicing between them puts EVERY block in exactly one
// unit and loses none. Returned as the per-unit block counts so a test can also assert where they land.
function unitSizes(starts: readonly PdfReadingUnitStart[], blockCount: number): readonly number[] {
  expect(starts[0]?.blockIndex ?? 0).toBe(0);
  const boundaries = starts.map((start) => start.blockIndex);
  expect(boundaries).toEqual([...boundaries].sort((left, right) => left - right));
  expect(new Set(boundaries).size).toBe(boundaries.length);
  const sizes = boundaries.map(
    (blockIndex, index) => (boundaries[index + 1] ?? blockCount) - blockIndex
  );
  expect(sizes.reduce((total, size) => total + size, 0)).toBe(blockCount);
  return sizes;
}

function titles(starts: readonly PdfReadingUnitStart[]): readonly (string | null)[] {
  return starts.map((start) => start.title);
}

describe("decidePdfReadingUnits", () => {
  it("makes no unit for a body with no blocks", () => {
    expect(decidePdfReadingUnits([])).toEqual([]);
  });

  it("keeps a heading-free body as one neutral unit", () => {
    const starts = decidePdfReadingUnits([BODY, BODY, BODY]);
    expect(titles(starts)).toEqual([null]);
    expect(unitSizes(starts, 3)).toEqual([3]);
  });

  describe("authored top-level divisions (the outline rule)", () => {
    it("starts a unit at each level-1 bookmark and keeps deeper bookmarks inside it", () => {
      // The real Clean Code shape: one level-1 chapter bookmark, its level-2 sections, then the next
      // chapter. The sections stay heading BLOCKS inside their chapter rather than opening a unit.
      const starts = decidePdfReadingUnits([
        authored(1, 0, "Chapter 6: Objects and Data Structures", "Objects and Data Structures"),
        BODY,
        authored(2, 1, "Data Abstraction"),
        BODY,
        authored(3, 2, "Train Wrecks"),
        BODY,
        authored(1, 3, "Chapter 7: Error Handling", "Error Handling"),
        BODY
      ]);
      expect(titles(starts)).toEqual([
        "Chapter 6: Objects and Data Structures",
        "Chapter 7: Error Handling"
      ]);
      expect(unitSizes(starts, 8)).toEqual([6, 2]);
    });

    it("titles the unit from the bookmark, not from the block's own text", () => {
      // The whole point of reading the authored navigation: the printed heading is `10`, the publisher
      // called the division `Chapter 10: Classes`.
      const starts = decidePdfReadingUnits([authored(1, 0, "Chapter 10: Classes", "10")]);
      expect(titles(starts)).toEqual(["Chapter 10: Classes"]);
    });

    it("opens ONE unit when docling splits a chapter opener into a label and a title", () => {
      // Measured on the real book: docling emits `10` and `Classes` as two level-1 headings and BOTH
      // resolve to the same bookmark (`chapter 10: classes` contains `10`). A bookmark names one
      // division, so the second half joins the unit the first opened instead of duplicating it.
      const starts = decidePdfReadingUnits([
        authored(1, 4, "Chapter 9: Unit Tests", "Unit Tests"),
        BODY,
        authored(1, 5, "Chapter 10: Classes", "10"),
        authored(1, 5, "Chapter 10: Classes", "Classes"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["Chapter 9: Unit Tests", "Chapter 10: Classes"]);
      // The label block opens the chapter, so it reads inside its own chapter and no block is orphaned.
      expect(unitSizes(starts, 5)).toEqual([2, 3]);
    });

    it("ignores a later restatement of a division already open", () => {
      // A running head docling kept as a heading restates its chapter title mid-chapter; it must not
      // re-open the chapter (which would split it in two).
      const starts = decidePdfReadingUnits([
        authored(1, 0, "Chapter 1: Clean Code"),
        BODY,
        BODY,
        authored(1, 0, "Chapter 1: Clean Code"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["Chapter 1: Clean Code"]);
      expect(unitSizes(starts, 5)).toEqual([5]);
    });

    it("keeps a leading run before the first division as one neutral unit", () => {
      const starts = decidePdfReadingUnits([
        BODY,
        labelled(2, "Front matter heading"),
        authored(1, 0, "Chapter 1: Clean Code"),
        BODY
      ]);
      expect(titles(starts)).toEqual([null, "Chapter 1: Clean Code"]);
      expect(unitSizes(starts, 4)).toEqual([2, 2]);
    });

    it("adds no leading unit when the first block is itself a division", () => {
      const starts = decidePdfReadingUnits([authored(1, 0, "Foreword"), BODY]);
      expect(titles(starts)).toEqual(["Foreword"]);
      expect(unitSizes(starts, 2)).toEqual([2]);
    });

    it("ignores a deeper bookmark and a label-derived heading as boundaries", () => {
      // Only the top rung of the authored navigation divides the work; a level-2 bookmark names a
      // section, and a heading no bookmark named carries no authored evidence at all.
      const starts = decidePdfReadingUnits([
        authored(1, 0, "Chapter 1: Clean Code"),
        authored(2, 1, "There Will Be Code"),
        labelled(1, "Uncatalogued Heading"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["Chapter 1: Clean Code"]);
      expect(unitSizes(starts, 4)).toEqual([4]);
    });

    it("falls back to the printed text when the bookmark's title is blank", () => {
      const starts = decidePdfReadingUnits([authored(1, 0, "   ", "Printed Heading")]);
      expect(titles(starts)).toEqual(["Printed Heading"]);
    });

    it("leaves a division untitled when neither the bookmark nor the block carries text", () => {
      const starts = decidePdfReadingUnits([authored(1, 0, "  ", "  "), BODY]);
      expect(titles(starts)).toEqual([null]);
      expect(unitSizes(starts, 2)).toEqual([2]);
    });
  });

  describe("fallback for a document with no authored top-level division", () => {
    it("splits at the shallowest heading level present and keeps deeper headings inside", () => {
      // A PDF with no embedded outline: every heading is label-derived. The shallowest level present is
      // the division level, so a book of H2 chapters with H3 sections still reads chapter by chapter.
      const starts = decidePdfReadingUnits([
        BODY,
        labelled(2, "First Chapter"),
        labelled(3, "A Section"),
        BODY,
        labelled(2, "Second Chapter"),
        BODY
      ]);
      expect(titles(starts)).toEqual([null, "First Chapter", "Second Chapter"]);
      expect(unitSizes(starts, 6)).toEqual([1, 3, 2]);
    });

    it("joins a bare chapter label to the title that follows it", () => {
      // The same label/title split docling produces, in a book whose outline is missing: `10` alone
      // names nothing, so it opens the unit and `Classes` names it — one unit, not a junk `10` unit.
      const starts = decidePdfReadingUnits([
        labelled(1, "10"),
        labelled(1, "Classes"),
        BODY,
        labelled(1, "11"),
        labelled(1, "Systems"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["10 Classes", "11 Systems"]);
      expect(unitSizes(starts, 6)).toEqual([3, 3]);
    });

    it.each([
      ["Appendix A", "Concurrency II", "Appendix A Concurrency II"],
      ["Chapter 12", "Emergence", "Chapter 12 Emergence"],
      ["Part I —", "The Beginning", "Part I — The Beginning"]
    ])("joins the %j label to %j", (label, title, expected) => {
      const starts = decidePdfReadingUnits([labelled(1, label), labelled(1, title), BODY]);
      expect(titles(starts)).toEqual([expected]);
      expect(unitSizes(starts, 3)).toEqual([3]);
    });

    it("joins a chain of labels through to the first heading that names the division", () => {
      const starts = decidePdfReadingUnits([
        labelled(1, "Part I"),
        labelled(1, "1"),
        labelled(1, "Clean Code"),
        BODY,
        labelled(1, "Meaningful Names"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["Part I 1 Clean Code", "Meaningful Names"]);
      expect(unitSizes(starts, 6)).toEqual([4, 2]);
    });

    it("does not join a label across intervening content", () => {
      // Joining only ever repairs an opener docling split in place. A label followed by body text is a
      // division on its own — swallowing the next chapter's heading would merge two chapters.
      const starts = decidePdfReadingUnits([
        labelled(1, "Appendix A"),
        BODY,
        labelled(1, "Appendix B"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["Appendix A", "Appendix B"]);
      expect(unitSizes(starts, 4)).toEqual([2, 2]);
    });

    it("leaves a trailing label as its own unit when nothing follows it", () => {
      const starts = decidePdfReadingUnits([labelled(1, "Body heading"), BODY, labelled(1, "17")]);
      expect(titles(starts)).toEqual(["Body heading", "17"]);
      expect(unitSizes(starts, 3)).toEqual([2, 1]);
    });

    it("does not join an untitled heading to the next division", () => {
      const starts = decidePdfReadingUnits([labelled(1, "   "), labelled(1, "Named"), BODY]);
      expect(titles(starts)).toEqual([null, "Named"]);
      expect(unitSizes(starts, 3)).toEqual([1, 2]);
    });

    it("treats a heading that merely begins with a numbering word as a name", () => {
      // The label test is `stripHeadingNumbering` (#815's matcher), not a `Chapter|Appendix|Part`
      // regex: an unnumbered heading that happens to start with one of those words names its own
      // division and must not swallow the next one.
      const starts = decidePdfReadingUnits([
        labelled(1, "Sections of a Report"),
        labelled(1, "Appendix Practice"),
        BODY
      ]);
      expect(titles(starts)).toEqual(["Sections of a Report", "Appendix Practice"]);
      expect(unitSizes(starts, 3)).toEqual([1, 2]);
    });

    it("uses the bookmark's title when the outline named only deeper headings", () => {
      // An outline that declares no level-1 entry still names the headings it does cover, so the
      // fallback splits at the shallowest level present and keeps the authored titles.
      const starts = decidePdfReadingUnits([
        authored(2, 0, "Data Abstraction", "Data  Abstraction"),
        BODY,
        authored(3, 1, "Train Wrecks"),
        authored(2, 2, "The Law of Demeter")
      ]);
      expect(titles(starts)).toEqual(["Data Abstraction", "The Law of Demeter"]);
      expect(unitSizes(starts, 4)).toEqual([3, 1]);
    });
  });

  it("places every block in exactly one unit across a long mixed body", () => {
    // Scale + mixture: 300 blocks, authored divisions, deeper sections, label-derived headings, and the
    // label/title split — the partition must still cover the body exactly once, in order.
    const headings: (PdfReadingUnitHeading | null)[] = [];
    for (let index = 0; index < 300; index += 1) {
      if (index % 50 === 0) {
        headings.push(authored(1, index / 50, `Chapter ${index / 50}: Title`, `${index / 50}`));
      } else if (index % 50 === 1) {
        headings.push(authored(1, (index - 1) / 50, `Chapter ${(index - 1) / 50}: Title`, "Title"));
      } else if (index % 10 === 0) {
        headings.push(authored(2, 100 + index, `Section ${index}`));
      } else if (index % 17 === 0) {
        headings.push(labelled(2, `Uncatalogued ${index}`));
      } else {
        headings.push(BODY);
      }
    }
    const starts = decidePdfReadingUnits(headings);
    expect(starts).toHaveLength(6);
    expect(unitSizes(starts, 300)).toEqual([50, 50, 50, 50, 50, 50]);
    expect(titles(starts)).toEqual([
      "Chapter 0: Title",
      "Chapter 1: Title",
      "Chapter 2: Title",
      "Chapter 3: Title",
      "Chapter 4: Title",
      "Chapter 5: Title"
    ]);
  });
});
