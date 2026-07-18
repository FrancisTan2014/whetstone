import { describe, expect, it } from "vitest";

import {
  enrollRecitationRequestSchema,
  parseEnrollRecitationRequest,
  parseRecitationOverviewDto,
  parseRecitationPlanDto,
  parseRecitationPlanListDto,
  parseRecitationReviewResponse,
  parseRecordRecitationReviewRequest,
  parseRecordRecitationReviewResponse,
  recitationOverviewDtoSchema,
  recitationReviewDtoSchema
} from "./recitationContracts.js";

const planDto = {
  createdAt: "2026-07-15T00:00:00.000Z",
  entryId: "plan-1",
  lastSessionAt: null,
  phase: "maintenance" as const,
  sessionCount: 0,
  updatedAt: "2026-07-15T00:00:00.000Z",
  workEntryId: "work-1",
  workTitle: "Ode"
};

const reviewDto = {
  dueAt: "2026-07-15T00:00:00.000Z",
  planEntryId: "plan-1",
  sourceText: "line one\nline two",
  state: "review" as const,
  workEntryId: "work-1",
  workTitle: "Ode"
};

describe("enrollRecitationRequestSchema", () => {
  it("accepts a non-blank workEntryId and drops any phase choice", () => {
    expect(parseEnrollRecitationRequest({ workEntryId: "work-1" })).toEqual({
      workEntryId: "work-1"
    });
  });

  it("rejects a blank workEntryId", () => {
    expect(enrollRecitationRequestSchema.safeParse({ workEntryId: "   " }).success).toBe(false);
  });

  it("rejects an unknown field such as a phase (no phase picker)", () => {
    expect(
      enrollRecitationRequestSchema.safeParse({ workEntryId: "work-1", phase: "maintenance" })
        .success
    ).toBe(false);
  });
});

describe("recitation plan DTOs", () => {
  it("parses a plan and a plan list", () => {
    expect(parseRecitationPlanDto(planDto)).toEqual(planDto);
    expect(parseRecitationPlanListDto({ plans: [planDto] })).toEqual({ plans: [planDto] });
  });

  it("still reads a legacy familiarizing phase for auditability", () => {
    expect(parseRecitationPlanDto({ ...planDto, phase: "familiarizing" }).phase).toBe(
      "familiarizing"
    );
  });
});

describe("recitation review DTOs", () => {
  it("parses a review response with a review", () => {
    expect(parseRecitationReviewResponse({ review: reviewDto })).toEqual({ review: reviewDto });
  });

  it("parses a null review response for an unenrolled Work", () => {
    expect(parseRecitationReviewResponse({ review: null })).toEqual({ review: null });
  });

  it("rejects an out-of-range card state", () => {
    expect(recitationReviewDtoSchema.safeParse({ ...reviewDto, state: "archived" }).success).toBe(
      false
    );
  });
});

const overviewWork = {
  isDue: true,
  nextReviewAt: "2026-07-15T00:00:00.000Z",
  paused: false,
  planEntryId: "plan-1",
  state: "review" as const,
  workEntryId: "work-1",
  workTitle: "Ode"
};

describe("recitation overview DTO", () => {
  it("parses an overview with enrolled Works and a due count", () => {
    expect(parseRecitationOverviewDto({ dueCount: 1, works: [overviewWork] })).toEqual({
      dueCount: 1,
      works: [overviewWork]
    });
  });

  it("accepts a removed-maintenance Work with a null schedule that is not due", () => {
    const parsed = parseRecitationOverviewDto({
      dueCount: 0,
      works: [{ ...overviewWork, isDue: false, nextReviewAt: null, state: null }]
    });
    expect(parsed.works[0]!.nextReviewAt).toBeNull();
    expect(parsed.works[0]!.state).toBeNull();
  });

  it("accepts a paused Work in the overview", () => {
    expect(
      parseRecitationOverviewDto({
        dueCount: 0,
        works: [{ ...overviewWork, isDue: false, paused: true }]
      }).works[0]!.paused
    ).toBe(true);
  });

  it("rejects an out-of-range card state in a Work", () => {
    expect(
      recitationOverviewDtoSchema.safeParse({
        dueCount: 0,
        works: [{ ...overviewWork, state: "archived" }]
      }).success
    ).toBe(false);
  });

  it("rejects a non-datetime next review instant", () => {
    expect(
      recitationOverviewDtoSchema.safeParse({
        dueCount: 0,
        works: [{ ...overviewWork, nextReviewAt: "not-a-date" }]
      }).success
    ).toBe(false);
  });

  it("rejects a negative due count", () => {
    expect(recitationOverviewDtoSchema.safeParse({ dueCount: -1, works: [] }).success).toBe(false);
  });
});

describe("record recitation review", () => {
  it("parses each valid rating", () => {
    for (const rating of ["again", "hard", "good", "easy"] as const) {
      expect(parseRecordRecitationReviewRequest({ rating })).toEqual({ rating });
    }
  });

  it("rejects an invented rating", () => {
    expect(() => parseRecordRecitationReviewRequest({ rating: "perfect" })).toThrow();
  });

  it("parses the rescheduled review response with the remaining due count", () => {
    expect(
      parseRecordRecitationReviewResponse({ remainingDueCount: 2, review: reviewDto })
    ).toEqual({ remainingDueCount: 2, review: reviewDto });
  });

  it("accepts a zero remaining due count (nothing else due)", () => {
    expect(
      parseRecordRecitationReviewResponse({ remainingDueCount: 0, review: reviewDto })
        .remainingDueCount
    ).toBe(0);
  });

  it("rejects a response missing the remaining due count", () => {
    expect(() => parseRecordRecitationReviewResponse({ review: reviewDto })).toThrow();
  });

  it("rejects a negative or non-integer remaining due count", () => {
    expect(() =>
      parseRecordRecitationReviewResponse({ remainingDueCount: -1, review: reviewDto })
    ).toThrow();
    expect(() =>
      parseRecordRecitationReviewResponse({ remainingDueCount: 1.5, review: reviewDto })
    ).toThrow();
  });
});
