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

// One unpaused plan's canonical recitation obligation, as the aggregate selector consumes it (#633). The
// server derives every field from live shared review-card + chain + whole-Work rows; the selector never
// touches the database or a persisted queue. `earliestDueAtMs` is the plan's earliest due review-card
// instant (a passage card or the started whole-Work card), or null when no card is due. A required step
// with no due card (an eligible owned-prefix chain, or an unstarted phase-eligible whole-Work step) is
// carried by `hasRequiredNonCardStep`, so a plan can hold a real obligation with `earliestDueAtMs` null.
export type RecitationPlanObligation = Readonly<{
  dueCount: number;
  earliestDueAtMs: number | null;
  hasRequiredNonCardStep: boolean;
  overdueCount: number;
  planEntryId: string;
}>;

// The aggregate due summary across every unpaused plan: the truthful global counts Today reports, plus
// the earliest due instant for ordering. `dueCount` sums each plan's due review cards AND its required
// non-card steps (an eligible chain / unstarted whole-Work counts as one untimed obligation), so a Work
// holding only cardless required work is never lost from the total (#633 AC1). `nextDueAtMs` is null
// exactly when no review card is due — a routine of only cardless required work has a positive
// `dueCount` yet a null `nextDueAtMs` (its obligations carry no timestamped instant).
export type RecitationAggregateDue = Readonly<{
  dueCount: number;
  nextDueAtMs: number | null;
  overdueCount: number;
}>;

// The global recitation routine selection (#633): the truthful aggregate due summary, whether any Work
// still holds required work, and which Work to work now (`selectedPlanEntryId`, null when nothing is
// required). Optional new material is offered only when `hasRequiredWork` is false — no Work may hide,
// defer, or reschedule required work behind an optional invitation.
export type RecitationWorkSelection = Readonly<{
  due: RecitationAggregateDue;
  hasRequiredWork: boolean;
  selectedPlanEntryId: string | null;
}>;

function planHasRequiredWork(plan: RecitationPlanObligation): boolean {
  return plan.dueCount > 0 || plan.hasRequiredNonCardStep;
}

// Order two required plans for global Work selection (#633). A plan with a due review card leads a plan
// whose only obligation is a non-card required step (an eligible chain / unstarted whole-Work) — so
// timestamped due items, overdue first, are always worked before untimed steps. Among due-card plans the
// earlier `earliestDueAtMs` leads; every remaining tie (equal instants, or two non-card-only plans)
// breaks on the stable plan id, so the pick is deterministic and never oscillates.
export function compareRecitationObligations(
  a: RecitationPlanObligation,
  b: RecitationPlanObligation
): number {
  const aTimed = a.earliestDueAtMs !== null;
  const bTimed = b.earliestDueAtMs !== null;
  if (aTimed !== bTimed) {
    return aTimed ? -1 : 1;
  }
  if (aTimed && bTimed && a.earliestDueAtMs !== b.earliestDueAtMs) {
    return a.earliestDueAtMs! - b.earliestDueAtMs!;
  }
  if (a.planEntryId === b.planEntryId) {
    return 0;
  }
  return a.planEntryId < b.planEntryId ? -1 : 1;
}

// Select the single Work the global routine works now, and the aggregate due summary, from every
// unpaused plan's obligation (#633). Recitation obligations are a read-time projection: this owns no
// durable queue and persists nothing. `due.dueCount` sums every plan's due review cards plus its
// required non-card steps (an eligible chain / unstarted whole-Work each count as one), and
// `nextDueAtMs` is the earliest due card instant, so a false all-clear is impossible while any Work
// holds required work — carded or not.
//
// `pinnedPlanEntryId` is the Work the caller is currently working. While that plan still holds required
// work it stays selected, so completing its required items never context-switches mid-Work after a
// rating (AC4); once it is clear the pin no longer matches and the next Work is chosen by
// `compareRecitationObligations`. With no pin (Today's summary read), the earliest-required Work leads.
export function selectRecitationWork(
  plans: readonly RecitationPlanObligation[],
  pinnedPlanEntryId: string | null
): RecitationWorkSelection {
  const due: RecitationAggregateDue = {
    dueCount: plans.reduce(
      (total, plan) => total + plan.dueCount + (plan.hasRequiredNonCardStep ? 1 : 0),
      0
    ),
    nextDueAtMs: plans.reduce<number | null>((earliest, plan) => {
      if (plan.earliestDueAtMs === null) {
        return earliest;
      }
      return earliest === null ? plan.earliestDueAtMs : Math.min(earliest, plan.earliestDueAtMs);
    }, null),
    overdueCount: plans.reduce((total, plan) => total + plan.overdueCount, 0)
  };

  const required = plans.filter(planHasRequiredWork);
  const hasRequiredWork = required.length > 0;

  const pinned =
    pinnedPlanEntryId === null
      ? undefined
      : required.find((plan) => plan.planEntryId === pinnedPlanEntryId);
  if (pinned !== undefined) {
    return { due, hasRequiredWork, selectedPlanEntryId: pinned.planEntryId };
  }

  if (!hasRequiredWork) {
    return { due, hasRequiredWork, selectedPlanEntryId: null };
  }
  const selected = [...required].sort(compareRecitationObligations)[0]!;
  return { due, hasRequiredWork, selectedPlanEntryId: selected.planEntryId };
}
