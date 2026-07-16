import { describe, expect, it } from "vitest";

import {
  compareRecitationObligations,
  isRequiredRecitationStep,
  type RecitationPlanObligation,
  recitationSessionSteps,
  selectRecitationSessionStep,
  selectRecitationWork
} from "./recitationSession.js";

describe("selectRecitationSessionStep", () => {
  it("lists the due-first session steps in priority order ending in clear", () => {
    expect(recitationSessionSteps).toEqual([
      "due_passage",
      "whole_work",
      "chain",
      "new_passage",
      "clear"
    ]);
  });

  it("prefers a due passage when every step is available", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: true,
        hasDuePassage: true,
        newPassageAvailable: true,
        wholeWorkDue: true
      })
    ).toBe("due_passage");
  });

  it("falls to whole-work before chain when no passage is due", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: true,
        hasDuePassage: false,
        newPassageAvailable: true,
        wholeWorkDue: true
      })
    ).toBe("whole_work");
  });

  it("falls to chain when no passage or whole-work target is due", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: true,
        hasDuePassage: false,
        newPassageAvailable: true,
        wholeWorkDue: false
      })
    ).toBe("chain");
  });

  it("falls to new-passage introduction after due work and chain are clear", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: false,
        hasDuePassage: false,
        newPassageAvailable: true,
        wholeWorkDue: false
      })
    ).toBe("new_passage");
  });

  it("is clear when no recitation session step remains", () => {
    expect(
      selectRecitationSessionStep({
        chainAvailable: false,
        hasDuePassage: false,
        newPassageAvailable: false,
        wholeWorkDue: false
      })
    ).toBe("clear");
  });
});

describe("isRequiredRecitationStep", () => {
  it("treats due-passage, whole-work, and chain as required obligations", () => {
    expect(isRequiredRecitationStep("due_passage")).toBe(true);
    expect(isRequiredRecitationStep("whole_work")).toBe(true);
    expect(isRequiredRecitationStep("chain")).toBe(true);
  });

  it("treats the new-passage invitation and the terminal clear as not required", () => {
    expect(isRequiredRecitationStep("new_passage")).toBe(false);
    expect(isRequiredRecitationStep("clear")).toBe(false);
  });
});

function obligation(
  overrides: Partial<RecitationPlanObligation> & Readonly<{ planEntryId: string }>
): RecitationPlanObligation {
  return {
    dueCount: 0,
    earliestDueAtMs: null,
    hasRequiredNonCardStep: false,
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

  it("counts every cardless required Work in the aggregate due total, never just one (#633 AC1)", () => {
    // Two active Works each hold only a required non-card step (an eligible chain or unstarted whole-Work):
    // no review card is due anywhere, so `nextDueAtMs` is null, yet both obligations must be counted or
    // Today under-reports the routine as a single due item.
    const selection = selectRecitationWork(
      [
        obligation({ hasRequiredNonCardStep: true, planEntryId: "chain-a" }),
        obligation({ hasRequiredNonCardStep: true, planEntryId: "whole-work-b" })
      ],
      null
    );
    expect(selection.due).toEqual({ dueCount: 2, nextDueAtMs: null, overdueCount: 0 });
    expect(selection.hasRequiredWork).toBe(true);
  });

  it("adds cardless required steps on top of due-card counts across mixed Works", () => {
    // A Work with due cards and a Work whose only obligation is a cardless required step must both count:
    // the total is the summed cards plus one per cardless required Work, and the earliest card instant
    // still orders the routine.
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 2, earliestDueAtMs: 400, overdueCount: 1, planEntryId: "cards" }),
        obligation({ hasRequiredNonCardStep: true, planEntryId: "chain-only" })
      ],
      null
    );
    expect(selection.due).toEqual({ dueCount: 3, nextDueAtMs: 400, overdueCount: 1 });
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

  it("selects a timestamped due plan before a plan whose only obligation is a non-card step", () => {
    const selection = selectRecitationWork(
      [
        obligation({ hasRequiredNonCardStep: true, planEntryId: "chain-only" }),
        obligation({ dueCount: 1, earliestDueAtMs: 999, planEntryId: "due-card" })
      ],
      null
    );
    expect(selection.selectedPlanEntryId).toBe("due-card");
  });

  it("breaks a tie between non-card-only plans on the stable plan id", () => {
    const selection = selectRecitationWork(
      [
        obligation({ hasRequiredNonCardStep: true, planEntryId: "zeta" }),
        obligation({ hasRequiredNonCardStep: true, planEntryId: "alpha" })
      ],
      null
    );
    expect(selection.selectedPlanEntryId).toBe("alpha");
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

  it("keeps the pinned Work while it still holds required work, never switching after a rating", () => {
    const selection = selectRecitationWork(
      [
        obligation({ dueCount: 1, earliestDueAtMs: 100, planEntryId: "other" }),
        obligation({ hasRequiredNonCardStep: true, planEntryId: "pinned" })
      ],
      "pinned"
    );
    expect(selection.selectedPlanEntryId).toBe("pinned");
  });

  it("advances past a pinned Work once it no longer holds required work", () => {
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
  it("orders a non-card-only plan after a timestamped due plan in both argument orders", () => {
    const timed = obligation({ dueCount: 1, earliestDueAtMs: 10, planEntryId: "timed" });
    const untimed = obligation({ hasRequiredNonCardStep: true, planEntryId: "untimed" });
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
