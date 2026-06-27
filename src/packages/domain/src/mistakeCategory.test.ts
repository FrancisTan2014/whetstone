import { describe, expect, it } from "vitest";

import { mistakeCategoryFromIssues } from "./mistakeCategory.js";

describe("mistakeCategoryFromIssues", () => {
  it("is null when there are no issues", () => {
    expect(mistakeCategoryFromIssues([])).toBeNull();
  });

  it.each([
    ["collocation", "wrong_collocation"],
    ["register", "register"],
    ["grammar", "other"],
    ["word_choice", "other"],
    ["pronunciation", "other"]
  ] as const)("maps issue kind %s to %s", (kind, category) => {
    expect(mistakeCategoryFromIssues([{ kind, severity: "minor" }])).toBe(category);
  });

  it("prefers a major issue over an earlier minor one", () => {
    expect(
      mistakeCategoryFromIssues([
        { kind: "word_choice", severity: "minor" },
        { kind: "register", severity: "major" }
      ])
    ).toBe("register");
  });

  it("falls back to other for an unknown kind", () => {
    expect(mistakeCategoryFromIssues([{ kind: "spelling", severity: "minor" }])).toBe("other");
  });
});
