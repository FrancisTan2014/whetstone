// Recitation familiarization routines (#577): the learner-controlled phases a recitation plan moves
// through. `familiarizing` is calm daily reading for rhythm and beauty with no memorization pressure;
// `learning` is active recitation the learner explicitly starts; `maintenance` is upkeep of a work the
// learner has already recited. The array order is the natural progression, but every transition is
// explicit and learner-driven — whetstone never infers readiness, requires a test, or auto-advances
// after N days (PRODUCT.md "Recitation routines"). Pure vocabulary: no persistence, DB, or I/O.
export const recitationPhases = ["familiarizing", "learning", "maintenance"] as const;

export type RecitationPhase = (typeof recitationPhases)[number];

const recitationPhaseSet: ReadonlySet<unknown> = new Set(recitationPhases);

export function isRecitationPhase(value: unknown): value is RecitationPhase {
  return recitationPhaseSet.has(value);
}
