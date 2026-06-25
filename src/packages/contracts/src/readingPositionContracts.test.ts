import { describe, expect, it } from "vitest";

import {
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
