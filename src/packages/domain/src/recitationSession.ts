// The transient due-first recitation session selector (#609). A session is not persisted; callers
// recompute these booleans from canonical Recitation targets/cards after every recorded action.

export const recitationSessionSteps = [
  "due_passage",
  "whole_work",
  "chain",
  "new_passage",
  "clear"
] as const;

export type RecitationSessionStep = (typeof recitationSessionSteps)[number];

// Select the next inline session step. This intentionally differs from `selectRecitationTodayAction`:
// the complete session sequences due whole-Work maintenance BEFORE chain rehearsal per #609 AC1, while
// Today still surfaces an active chain before whole-Work per #580. Both selectors stay pure boolean
// priorities so each surface can keep its own product order without duplicating persistence state.
export function selectRecitationSessionStep(
  input: Readonly<{
    chainAvailable: boolean;
    hasDuePassage: boolean;
    newPassageAvailable: boolean;
    wholeWorkDue: boolean;
  }>
): RecitationSessionStep {
  if (input.hasDuePassage) {
    return "due_passage";
  }
  if (input.wholeWorkDue) {
    return "whole_work";
  }
  if (input.chainAvailable) {
    return "chain";
  }
  if (input.newPassageAvailable) {
    return "new_passage";
  }
  return "clear";
}

// Whether a session step is a deterministic obligation the learner must clear — a due passage, due
// whole-Work maintenance, or an eligible chain — as opposed to the optional `new_passage` invitation or
// the terminal `clear`. Today keeps the Recitation routine due while the session sits on any required
// step, even when no individual review card is due yet: an unstarted whole-Work step or an eligible
// owned-prefix chain carries no card, so a card-only view would falsely report the routine clear (#610).
export function isRequiredRecitationStep(step: RecitationSessionStep): boolean {
  return recitationSessionSteps.indexOf(step) < recitationSessionSteps.indexOf("new_passage");
}
