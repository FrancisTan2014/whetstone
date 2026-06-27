// The pure bridge from the coach's production verdict to #188's SM-2 grade: the LLM (or the
// deterministic fake) JUDGES production quality into a discrete category, and this maps that category
// to the 0..5 grade the scheduler consumes. The mapping is deterministic and model-agnostic — it
// never costs a token and never changes when a real model is wired in (the LLM grades; SM-2
// schedules).

import type { ReviewGrade } from "./sm2.js";

// The discrete quality verdict for a spoken production attempt, from worst to best. Mirrored as a Zod
// enum in `@whetstone/contracts` (`coachContracts.ts`); keep the two in sync.
export const productionCategories = [
  "off_target",
  "incorrect",
  "awkward",
  "understandable",
  "good",
  "native_like"
] as const;

export type ProductionCategory = (typeof productionCategories)[number];

// Each verdict maps to one SM-2 grade (0..5): a clean, deterministic 1:1 ladder rather than a
// threshold on a float, so a planted change to the mapping fails a test. "off_target" (said something
// unrelated) is a total miss (0); "native_like" is a perfect recall (5); below "understandable" (3)
// is an SM-2 lapse.
const categoryToGrade: Readonly<Record<ProductionCategory, ReviewGrade>> = Object.freeze({
  off_target: 0,
  incorrect: 1,
  awkward: 2,
  understandable: 3,
  good: 4,
  native_like: 5
});

export function judgementToGrade(category: ProductionCategory): ReviewGrade {
  return categoryToGrade[category];
}
