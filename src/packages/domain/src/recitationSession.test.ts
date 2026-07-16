import { describe, expect, it } from "vitest";

import {
  compareRecitationObligations,
  type RecitationPlanObligation,
  selectRecitationWork
} from "./recitationSession.js";

function obligation(
  overrides: Partial<RecitationPlanObligation> & Readonly<{ planEntryId: string }>
): RecitationPlanObligation {
  return {
    dueCount: 0,
    earliestDueAtMs: null,
    overdueCount: 0,
    ...overrides
  };
}

describe("selectRecitationWork", () => {
  it("sums the aggregate due counts and takes the earliest due instant across every plan", () => {
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 2, earliestDueAtMs: 300, overdueCount: 1, planEntryId: "a" }),
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "b" }),
        obligation({ planEntryId: "c" })
      ],
      null
    );
    expect(selection.due).toEqual({ dueCount: 3, nextDueAtMs: 100, overdueCount: 1 });
    expect(selection.hasRequiredWork).toBe(true);
  });

  it("selects the Work whose earliest due card is soonest, so overdue work leads", () => {
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 1, earliestDueAtMs: 500, planEntryId: "later" }),
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "overdue" })
      ],
      null
    );
    expect(selection.selectedPlanEntryId).toBe("overdue");
  });

  it("breaks a tie between equal due instants on the stable plan id", () => {
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "beta" }),
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "alpha" })
      ],
      null
    );
    expect(selection.selectedPlanEntryId).toBe("alpha");
  });

  it("keeps the pinned Work while its card is still due, never switching after a rating", () => {
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 1, earliestDueAtMs: 50, planEntryId: "other" }),
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "pinned" })
      ],
      "pinned"
    );
    expect(selection.selectedPlanEntryId).toBe("pinned");
  });

  it("advances past a pinned Work once its card is no longer due", () => {
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "next" }),
        obligation({ planEntryId: "pinned" })
      ],
      "pinned"
    );
    expect(selection.selectedPlanEntryId).toBe("next");
  });

  it("selects nothing and reports no required work when every plan is clear", () => {
    const selection = selectRecitationWork(
      [obligation({ planEntryId: "a" }), obligation({ planEntryId: "b" })],
      null
    );
    expect(selection).toEqual({
      due: { dueCount: 0, nextDueAtMs: null, overdueCount: 0 },
      hasRequiredWork: false,
      selectedPlanEntryId: null
    });
  });
});

describe("compareRecitationObligations", () => {
  it("orders an untimed obligation after a timestamped due plan in both argument orders", () => {
    const timed = obligation({ dueCount: 1, earliestDueAtMs: 10, planEntryId: "timed" });
    const untimed = obligation({ planEntryId: "untimed" });
    expect(compareRecitationObligations(untimed, timed)).toBe(1);
    expect(compareRecitationObligations(timed, untimed)).toBe(-1);
  });

  it("returns 0 for two obligations with the same key and id", () => {
    const a = obligation({ dueCount: 1, earliestDueAtMs: 5, planEntryId: "same" });
    expect(compareRecitationObligations(a, { ...a })).toBe(0);
  });

  it("breaks an equal-instant tie by id in both directions", () => {
    const first = obligation({ dueCount: 1, earliestDueAtMs: 5, planEntryId: "a" });
    const second = obligation({ dueCount: 1, earliestDueAtMs: 5, planEntryId: "b" });
    expect(compareRecitationObligations(first, second)).toBe(-1);
    expect(compareRecitationObligations(second, first)).toBe(1);
  });
});
