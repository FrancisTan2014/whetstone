// The pure bridge from the coach's production verdict to the FSRS rating the scheduler consumes
// (#572): the LLM (or the deterministic fake) JUDGES production quality into a discrete category, and
// this maps that category to one of the four ratings again/hard/good/easy. The mapping is
// deterministic and model-agnostic — it never costs a token and never changes when a real model is
// wired in (the LLM grades; FSRS schedules).

import type { ReviewRating } from "./fsrs.js";

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

// Each verdict maps to one of the four FSRS ratings: a clean, deterministic ladder rather than a
// threshold on a float, so a planted change to the mapping fails a test. The six-way verdict collapses
// onto the four ratings — a total/near miss ("off_target"/"incorrect") is "again", a clumsy-but-present
// attempt ("awkward"/"understandable") is "hard", a solid attempt ("good") is "good", and a
// native-level one ("native_like") is "easy".
const categoryToRating: Readonly<Record<ProductionCategory, ReviewRating>> = Object.freeze({
  off_target: "again",
  incorrect: "again",
  awkward: "hard",
  understandable: "hard",
  good: "good",
  native_like: "easy"
});

export function judgementToRating(category: ProductionCategory): ReviewRating {
  return categoryToRating[category];
}
