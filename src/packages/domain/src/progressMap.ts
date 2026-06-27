// Pure presentation derivation (#210): turn a case's mastery summary into its fog-of-war light level —
// lit (owned), dim (in progress), or dark (unknown). This is visualization over the existing mastery
// data (#205/#189), not new scoring: it only buckets the counts the summary already carries.

import type { CaseMasterySummary } from "./caseMastery.js";

// A case's place in the fog of war: lit = fully owned, dim = started but not owned, dark = untouched.
export const caseLightLevels = ["lit", "dim", "dark"] as const;

export type CaseLightLevel = (typeof caseLightLevels)[number];

export function caseLightLevel(summary: CaseMasterySummary): CaseLightLevel {
  if (summary.totalChunks === 0) {
    return "dark";
  }

  if (summary.masteredChunks === summary.totalChunks) {
    return "lit";
  }

  // Any chunk past "new" (learning, due, or mastered) means the region is in progress.
  return summary.newChunks < summary.totalChunks ? "dim" : "dark";
}
