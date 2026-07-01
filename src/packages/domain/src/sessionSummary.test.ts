import { describe, expect, it } from "vitest";

import { summarizeSessionTurns } from "./sessionSummary.js";

describe("summarizeSessionTurns", () => {
  it("is all-zero for an empty session", () => {
    expect(summarizeSessionTurns([])).toEqual({
      averageGrade: 0,
      errorCounts: [],
      strongTurns: 0,
      turnCount: 0
    });
  });

  it("counts turns, averages grades, counts strong turns, and tallies errors", () => {
    const summary = summarizeSessionTurns([
      { errorCategory: null, grade: 5 },
      { errorCategory: "article_drop", grade: 2 },
      { errorCategory: "article_drop", grade: 4 },
      { errorCategory: "register", grade: 1 },
      { errorCategory: "word_order", grade: 4 }
    ]);

    expect(summary.turnCount).toBe(5);
    expect(summary.averageGrade).toBe(3.2);
    expect(summary.strongTurns).toBe(3);
    // Most frequent first; ties broken by category name (register before word_order).
    expect(summary.errorCounts).toEqual([
      { category: "article_drop", count: 2 },
      { category: "register", count: 1 },
      { category: "word_order", count: 1 }
    ]);
  });

  it("sorts errors by descending count then alphabetically, regardless of first-appearance order", () => {
    // word_order appears first but must sort last: article_drop wins on count, and the count-1 tie
    // between register and word_order breaks alphabetically (register), not by insertion order. This
    // forces the comparator to actually reorder, so a broken tie-break/count comparison is caught.
    const summary = summarizeSessionTurns([
      { errorCategory: "word_order", grade: 1 },
      { errorCategory: "article_drop", grade: 1 },
      { errorCategory: "article_drop", grade: 1 },
      { errorCategory: "register", grade: 1 }
    ]);

    expect(summary.errorCounts).toEqual([
      { category: "article_drop", count: 2 },
      { category: "register", count: 1 },
      { category: "word_order", count: 1 }
    ]);
  });
});
