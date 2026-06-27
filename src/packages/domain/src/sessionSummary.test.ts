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
});
