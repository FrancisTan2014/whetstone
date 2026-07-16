// The global recitation routine aggregate (#633). Recitation obligations are a read-time projection over
// every unpaused plan's Work-level maintenance review card; the selector never touches the database or a
// persisted queue. A session is not persisted — callers recompute these values from canonical
// Work-level Recitation cards after every recorded action.

// One unpaused plan's canonical recitation obligation, as the aggregate selector consumes it (#633). The
// server derives every field from the plan's live Work-level review card (#643); the selector never
// touches the database or a persisted queue. `earliestDueAtMs` is the plan's due Work-level card instant,
// or null when its card is not due.
export type RecitationPlanObligation = Readonly<{
  dueCount: number;
  earliestDueAtMs: number | null;
  overdueCount: number;
  planEntryId: string;
}>;

// The aggregate due summary across every unpaused plan: the truthful global counts Today reports, plus
// the earliest due instant for ordering. `dueCount` sums each plan's due Work-level review cards, and
// `nextDueAtMs` is null exactly when no card is due — so `dueCount > 0` iff `nextDueAtMs` is non-null.
export type RecitationAggregateDue = Readonly<{
  dueCount: number;
  nextDueAtMs: number | null;
  overdueCount: number;
}>;

// The global recitation routine selection (#633): the truthful aggregate due summary, whether any Work
// still holds a due card, and which Work to work now (`selectedPlanEntryId`, null when nothing is due).
export type RecitationWorkSelection = Readonly<{
  due: RecitationAggregateDue;
  hasRequiredWork: boolean;
  selectedPlanEntryId: string | null;
}>;

function planHasRequiredWork(plan: RecitationPlanObligation): boolean {
  return plan.dueCount > 0;
}

// Order two required plans for global Work selection (#633). The earlier `earliestDueAtMs` leads (overdue
// first); every remaining tie (equal instants) breaks on the stable plan id, so the pick is deterministic
// and never oscillates. A required plan always has a due card, so its `earliestDueAtMs` is non-null.
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
// durable queue and persists nothing. `due.dueCount` sums every plan's due Work-level review cards and
// `nextDueAtMs` is the earliest due card instant, so a false all-clear is impossible while any Work
// holds a due card.
//
// `pinnedPlanEntryId` is the Work the caller is currently working. While that plan still holds a due
// card it stays selected, so completing its items never context-switches mid-Work after a rating (AC4);
// once it is clear the pin no longer matches and the next Work is chosen by
// `compareRecitationObligations`. With no pin (Today's summary read), the earliest-required Work leads.
export function selectRecitationWork(
  plans: readonly RecitationPlanObligation[],
  pinnedPlanEntryId: string | null
): RecitationWorkSelection {
  const due: RecitationAggregateDue = {
    dueCount: plans.reduce((total, plan) => total + plan.dueCount, 0),
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
