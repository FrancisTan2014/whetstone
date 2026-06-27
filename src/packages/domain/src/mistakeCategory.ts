// Pure mapping from a coach judgement's diagnosed issues to the learner-model error category (#208),
// so each practice turn can deposit a mistake category. The coach (#206) diagnoses issues by `kind`;
// this picks the dominant issue (a major one if present) and maps it to the #208 taxonomy. No model,
// persistence, or I/O.

import type { ErrorCategory } from "./learnerModel.js";

export type ProductionIssueLike = Readonly<{
  kind: string;
  severity: "minor" | "major";
}>;

// Only collocation and register map cleanly onto a specific #208 category; the rest are recorded as a
// generic "other" rather than over-claiming a precise grammatical cause.
const categoryByKind: Readonly<Record<string, ErrorCategory>> = {
  collocation: "wrong_collocation",
  grammar: "other",
  other: "other",
  pronunciation: "other",
  register: "register",
  word_choice: "other"
};

export function mistakeCategoryFromIssues(
  issues: ReadonlyArray<ProductionIssueLike>
): ErrorCategory | null {
  const chosen = issues.find((issue) => issue.severity === "major") ?? issues[0];
  if (chosen === undefined) {
    return null;
  }

  return categoryByKind[chosen.kind] ?? "other";
}
