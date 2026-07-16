// Recitation familiarization routines (#577): the learner-controlled phases a recitation plan moves
// through. `familiarizing` is calm daily reading for rhythm and beauty with no memorization pressure;
// `learning` is active recitation the learner explicitly starts; `maintenance` is upkeep of a work the
// learner has already recited. Direct maintenance (#643) always enrols a Work straight into
// `maintenance`; the earlier phases are retained only so legacy plan rows stay readable. Pure
// vocabulary: no persistence, DB, or I/O.
import type { ReviewRating } from "./fsrs.js";

export const recitationPhases = ["familiarizing", "learning", "maintenance"] as const;

export type RecitationPhase = (typeof recitationPhases)[number];

const recitationPhaseSet: ReadonlySet<unknown> = new Set(recitationPhases);

export function isRecitationPhase(value: unknown): value is RecitationPhase {
  return recitationPhaseSet.has(value);
}

// The learner-facing rating scale for a Work-level Recitation maintenance review (#643): the learner
// attempts the whole Work, reveals the canonical source, then self-rates how the recall went. The four
// choices map one-to-one onto the shared FSRS ratings, in worst→best order, so the review UI never
// invents its own scale and the rating is never inferred from enrolment.
export const recitationRatingChoices = [
  { label: "Couldn't continue", rating: "again" },
  { label: "Needed cues", rating: "hard" },
  { label: "Complete, with effort", rating: "good" },
  { label: "Clean and natural", rating: "easy" }
] as const satisfies ReadonlyArray<{ label: string; rating: ReviewRating }>;

export type RecitationRatingChoice = (typeof recitationRatingChoices)[number];
