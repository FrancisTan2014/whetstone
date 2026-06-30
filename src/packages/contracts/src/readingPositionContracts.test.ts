import { describe, expect, it } from "vitest";

import {
  latestReadingPositionResponseSchema,
  parseLatestReadingPositionResponse,
  parseReadingPositionResponse,
  parseUpsertReadingPositionRequest,
  readingPositionResponseSchema,
  upsertReadingPositionRequestSchema
} from "./readingPositionContracts.js";

describe("parseUpsertReadingPositionRequest", () => {
  it("accepts a unit with a block anchor", () => {
    expect(
      parseUpsertReadingPositionRequest({ anchorBlockEntryId: "block-1", unitEntryId: "unit-1" })
    ).toEqual({ anchorBlockEntryId: "block-1", unitEntryId: "unit-1" });
  });

  it("accepts a unit without an anchor (top of the unit)", () => {
    expect(parseUpsertReadingPositionRequest({ unitEntryId: "unit-1" })).toEqual({
      unitEntryId: "unit-1"
    });
  });

  it("accepts an explicit null anchor", () => {
    expect(
      parseUpsertReadingPositionRequest({ anchorBlockEntryId: null, unitEntryId: "unit-1" })
    ).toEqual({ anchorBlockEntryId: null, unitEntryId: "unit-1" });
  });

  it("rejects a blank unit id", () => {
    expect(() => parseUpsertReadingPositionRequest({ unitEntryId: " " })).toThrow();
  });

  it("rejects a blank anchor block id", () => {
    expect(
      upsertReadingPositionRequestSchema.safeParse({
        anchorBlockEntryId: " ",
        unitEntryId: "unit-1"
      }).success
    ).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(
      upsertReadingPositionRequestSchema.safeParse({ extra: 1, unitEntryId: "unit-1" }).success
    ).toBe(false);
  });
});

describe("parseReadingPositionResponse", () => {
  it("accepts a saved position with an anchor", () => {
    const response = { position: { anchorBlockEntryId: "block-1", unitEntryId: "unit-1" } };

    expect(parseReadingPositionResponse(response)).toEqual(response);
  });

  it("accepts a saved position with a null anchor", () => {
    const response = { position: { anchorBlockEntryId: null, unitEntryId: "unit-1" } };

    expect(parseReadingPositionResponse(response)).toEqual(response);
  });

  it("accepts an explicit no-saved-position null", () => {
    expect(parseReadingPositionResponse({ position: null })).toEqual({ position: null });
  });

  it("rejects a missing position field", () => {
    expect(readingPositionResponseSchema.safeParse({}).success).toBe(false);
  });
});

describe("parseLatestReadingPositionResponse", () => {
  it("accepts a latest position with a work title and block anchor", () => {
    const response = {
      position: {
        anchorBlockEntryId: "block-1",
        unitEntryId: "unit-1",
        workEntryId: "work-1",
        workTitle: "Fables"
      }
    };

    expect(parseLatestReadingPositionResponse(response)).toEqual(response);
  });

  it("accepts a latest position with a null anchor (top of the unit)", () => {
    const response = {
      position: {
        anchorBlockEntryId: null,
        unitEntryId: "unit-1",
        workEntryId: "work-1",
        workTitle: "Fables"
      }
    };

    expect(parseLatestReadingPositionResponse(response)).toEqual(response);
  });

  it("accepts an explicit no-position null", () => {
    expect(parseLatestReadingPositionResponse({ position: null })).toEqual({ position: null });
  });

  it("rejects a position missing its work title", () => {
    expect(
      latestReadingPositionResponseSchema.safeParse({
        position: { unitEntryId: "unit-1", workEntryId: "work-1" }
      }).success
    ).toBe(false);
  });

  it("rejects unknown keys on the position", () => {
    expect(
      latestReadingPositionResponseSchema.safeParse({
        position: { extra: 1, unitEntryId: "unit-1", workEntryId: "work-1", workTitle: "Fables" }
      }).success
    ).toBe(false);
  });
});
