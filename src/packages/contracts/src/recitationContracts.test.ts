import { describe, expect, it } from "vitest";

import {
  continueRecitationDtoSchema,
  createRecitationPlanRequestSchema,
  parseContinueRecitationDto,
  parseCreateRecitationPlanRequest,
  parseRecitationPlanDto,
  parseRecitationPlanListDto,
  parseSetRecitationPhaseRequest,
  recitationPlanDtoSchema,
  recitationPlanListDtoSchema,
  setRecitationPhaseRequestSchema
} from "./recitationContracts.js";
import { timelineEntryDtoSchema } from "./diaryContracts.js";

const plan = {
  createdAt: "2026-07-01T09:00:00.000Z",
  entryId: "plan-1",
  lastSessionAt: null,
  phase: "familiarizing" as const,
  sessionCount: 0,
  updatedAt: "2026-07-01T09:00:00.000Z",
  workEntryId: "work-1",
  workTitle: "Aesop’s Fables"
};

describe("parseCreateRecitationPlanRequest", () => {
  it("accepts a work id with a valid phase", () => {
    expect(
      parseCreateRecitationPlanRequest({ phase: "maintenance", workEntryId: "work-1" })
    ).toEqual({ phase: "maintenance", workEntryId: "work-1" });
  });

  it("rejects a blank work id", () => {
    expect(
      createRecitationPlanRequestSchema.safeParse({ phase: "learning", workEntryId: " " }).success
    ).toBe(false);
  });

  it("rejects an unknown phase", () => {
    expect(
      createRecitationPlanRequestSchema.safeParse({ phase: "reciting", workEntryId: "work-1" })
        .success
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      createRecitationPlanRequestSchema.safeParse({
        extra: 1,
        phase: "learning",
        workEntryId: "work-1"
      }).success
    ).toBe(false);
  });
});

describe("parseSetRecitationPhaseRequest", () => {
  it("accepts a valid phase", () => {
    expect(parseSetRecitationPhaseRequest({ phase: "learning" })).toEqual({ phase: "learning" });
  });

  it("rejects an invalid phase", () => {
    expect(setRecitationPhaseRequestSchema.safeParse({ phase: "nope" }).success).toBe(false);
  });
});

describe("parseRecitationPlanDto", () => {
  it("accepts a plan with no recorded session", () => {
    expect(parseRecitationPlanDto(plan)).toEqual(plan);
  });

  it("accepts a plan with a recorded session and count", () => {
    const practised = { ...plan, lastSessionAt: "2026-07-04T09:00:00.000Z", sessionCount: 3 };

    expect(parseRecitationPlanDto(practised)).toEqual(practised);
  });

  it("rejects a negative session count", () => {
    expect(recitationPlanDtoSchema.safeParse({ ...plan, sessionCount: -1 }).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(recitationPlanDtoSchema.safeParse({ ...plan, extra: 1 }).success).toBe(false);
  });
});

describe("parseRecitationPlanListDto", () => {
  it("accepts a list of plans", () => {
    expect(parseRecitationPlanListDto({ plans: [plan] })).toEqual({ plans: [plan] });
  });

  it("rejects a missing plans field", () => {
    expect(recitationPlanListDtoSchema.safeParse({}).success).toBe(false);
  });
});

describe("parseContinueRecitationDto", () => {
  it("accepts a plan", () => {
    expect(parseContinueRecitationDto({ plan })).toEqual({ plan });
  });

  it("accepts an explicit no-plan null", () => {
    expect(parseContinueRecitationDto({ plan: null })).toEqual({ plan: null });
  });

  it("rejects a missing plan field", () => {
    expect(continueRecitationDtoSchema.safeParse({}).success).toBe(false);
  });
});

describe("timeline recitation entry", () => {
  it("parses a recitation entry in the timeline union", () => {
    const entry = {
      entryId: "plan-1",
      kind: "recitation" as const,
      occurredAt: "2026-07-01T09:00:00.000Z",
      phase: "learning" as const,
      title: "腾王阁序",
      workEntryId: "work-1"
    };

    expect(timelineEntryDtoSchema.parse(entry)).toEqual(entry);
  });

  it("rejects a recitation entry with an invalid phase", () => {
    expect(
      timelineEntryDtoSchema.safeParse({
        entryId: "plan-1",
        kind: "recitation",
        occurredAt: "2026-07-01T09:00:00.000Z",
        phase: "nope",
        title: "腾王阁序",
        workEntryId: "work-1"
      }).success
    ).toBe(false);
  });
});
