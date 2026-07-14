import type { RecitationPhase } from "./recitation.js";

// The recitation routine hub's derived "where am I in this Work" stage (#608). It is a pure projection
// over canonical plan state — the learner-controlled phase plus whether contiguous chaining is live or
// available — never a stored flag. The hub owns no parallel progress; this is the single place the four
// human stage labels are decided so the hub and any future session surface can never disagree.
export const recitationRoutineStages = [
  "familiarize",
  "learn_passage",
  "chain",
  "whole_work_maintenance"
] as const;

export type RecitationRoutineStage = (typeof recitationRoutineStages)[number];

// Derive the routine stage from canonical rows. `familiarizing` reads for wording (no cards) →
// `familiarize`; `maintenance` recites the whole Work → `whole_work_maintenance`. In `learning` the
// learner is either working contiguous chains — an active chain is open, or the owned prefix already
// makes one eligible — → `chain`, or still learning individual passages → `learn_passage`.
export function deriveRecitationStage(
  input: Readonly<{ phase: RecitationPhase; hasActiveChain: boolean; chainEligible: boolean }>
): RecitationRoutineStage {
  if (input.phase === "familiarizing") {
    return "familiarize";
  }
  if (input.phase === "maintenance") {
    return "whole_work_maintenance";
  }
  return input.hasActiveChain || input.chainEligible ? "chain" : "learn_passage";
}
