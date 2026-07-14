import { describe, expect, it } from "vitest";

import { parseRecitationHubResponse, recitationHubDtoSchema } from "./recitationHubContracts.js";

const introduction = {
  anyIntroduced: true,
  dailyCap: 3,
  dueCount: 1,
  introducedToday: 1,
  newPassageAvailable: false,
  nextQueued: null,
  phase: "learning",
  planEntryId: "plan-1",
  reason: "due_work_remains",
  remainingCapacity: 2
} as const;

const activeHub = {
  due: { dueCount: 2, overdueCount: 1 },
  introduction,
  passages: { introducedCount: 4, totalCount: 12 },
  paused: false,
  phase: "learning",
  planEntryId: "plan-1",
  primaryAction: "due_passage",
  stage: "learn_passage",
  status: "active",
  workTitle: "Ode"
} as const;

describe("recitationHubDtoSchema", () => {
  it("accepts the no_plan state", () => {
    expect(recitationHubDtoSchema.parse({ status: "no_plan" })).toEqual({ status: "no_plan" });
  });

  it("accepts a fully-specified active hub", () => {
    expect(recitationHubDtoSchema.parse(activeHub)).toEqual(activeHub);
  });

  it("rejects an unknown status discriminator", () => {
    expect(() => recitationHubDtoSchema.parse({ status: "paused" })).toThrow();
  });

  it("rejects an unknown stage value", () => {
    expect(() => recitationHubDtoSchema.parse({ ...activeHub, stage: "review" })).toThrow();
  });

  it("rejects an unknown primary action", () => {
    expect(() => recitationHubDtoSchema.parse({ ...activeHub, primaryAction: "start" })).toThrow();
  });

  it("rejects a negative due count", () => {
    expect(() =>
      recitationHubDtoSchema.parse({ ...activeHub, due: { dueCount: -1, overdueCount: 0 } })
    ).toThrow();
  });

  it("rejects unknown extra keys on the active hub (strict)", () => {
    expect(() => recitationHubDtoSchema.parse({ ...activeHub, extra: true })).toThrow();
  });

  it("rejects unknown extra keys on the no_plan hub (strict)", () => {
    expect(() => recitationHubDtoSchema.parse({ status: "no_plan", extra: true })).toThrow();
  });

  it("rejects a non-integer introduced count", () => {
    expect(() =>
      recitationHubDtoSchema.parse({
        ...activeHub,
        passages: { introducedCount: 1.5, totalCount: 2 }
      })
    ).toThrow();
  });
});

describe("parseRecitationHubResponse", () => {
  it("parses a response envelope wrapping the hub", () => {
    expect(parseRecitationHubResponse({ hub: activeHub })).toEqual({ hub: activeHub });
  });

  it("rejects a response missing the hub", () => {
    expect(() => parseRecitationHubResponse({})).toThrow();
  });

  it("rejects a response with extra keys (strict)", () => {
    expect(() => parseRecitationHubResponse({ hub: activeHub, extra: 1 })).toThrow();
  });
});
