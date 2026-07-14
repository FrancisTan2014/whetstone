import { describe, expect, it } from "vitest";

import {
  parseRecitationSessionResponse,
  recitationSessionDtoSchema
} from "./recitationSessionContracts.js";

const activeSession = {
  chainAvailable: true,
  due: { dueCount: 2, nextDueAt: "2026-07-15T00:00:00.000Z", overdueCount: 1 },
  hasDuePassage: true,
  newPassage: {
    anyIntroduced: true,
    available: false,
    dailyCap: 3,
    introducedToday: 1,
    remainingCapacity: 2
  },
  paused: false,
  planEntryId: "plan-1",
  status: "active",
  step: "due_passage",
  wholeWorkDue: true,
  workTitle: "Ode"
} as const;

describe("recitationSessionDtoSchema", () => {
  it("accepts the no_plan state", () => {
    expect(recitationSessionDtoSchema.parse({ status: "no_plan" })).toEqual({
      status: "no_plan"
    });
  });

  it("accepts a fully-specified active session", () => {
    expect(recitationSessionDtoSchema.parse(activeSession)).toEqual(activeSession);
  });

  it("rejects an unknown step value", () => {
    expect(() => recitationSessionDtoSchema.parse({ ...activeSession, step: "review" })).toThrow();
  });

  it("rejects a negative due count", () => {
    expect(() =>
      recitationSessionDtoSchema.parse({
        ...activeSession,
        due: { dueCount: -1, nextDueAt: null, overdueCount: 0 }
      })
    ).toThrow();
  });

  it("rejects unknown extra keys on the active session", () => {
    expect(() => recitationSessionDtoSchema.parse({ ...activeSession, extra: true })).toThrow();
  });

  it("rejects unknown extra keys on the no_plan session", () => {
    expect(() => recitationSessionDtoSchema.parse({ status: "no_plan", extra: true })).toThrow();
  });
});

describe("parseRecitationSessionResponse", () => {
  it("parses a no-plan response envelope", () => {
    expect(parseRecitationSessionResponse({ session: { status: "no_plan" } })).toEqual({
      session: { status: "no_plan" }
    });
  });

  it("parses an active response envelope", () => {
    expect(parseRecitationSessionResponse({ session: activeSession })).toEqual({
      session: activeSession
    });
  });

  it("rejects a response missing the session", () => {
    expect(() => parseRecitationSessionResponse({})).toThrow();
  });
});
