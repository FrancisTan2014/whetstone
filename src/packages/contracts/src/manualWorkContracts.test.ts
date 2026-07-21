import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import { parseManualWorkDto, parseUpdateManualWorkContentRequest } from "./manualWorkContracts.js";

const document = createTextDocument("A curated passage.");

const dto = {
  createdAt: "2026-07-01T10:00:00.000Z",
  document,
  entryId: "work-1",
  language: "en" as const,
  revision: "2026-07-01T11:00:00.000Z",
  title: "My source",
  unitEntryId: "unit-1",
  updatedAt: "2026-07-01T11:00:00.000Z",
  workType: "book" as const
};

describe("parseUpdateManualWorkContentRequest", () => {
  it("accepts a document with its revision token", () => {
    const request = { document, revision: "2026-07-01T11:00:00.000Z" };
    expect(parseUpdateManualWorkContentRequest(request)).toEqual(request);
  });

  it("rejects a request missing its revision", () => {
    expect(() => parseUpdateManualWorkContentRequest({ document })).toThrow();
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseUpdateManualWorkContentRequest({ document: { type: "not-a-doc" }, revision: "r" })
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() =>
      parseUpdateManualWorkContentRequest({ document, extra: true, revision: "r" })
    ).toThrow();
  });
});

describe("parseManualWorkDto", () => {
  it("round-trips a full manual work with its document and revision", () => {
    expect(parseManualWorkDto(dto)).toEqual(dto);
  });

  it("rejects an unknown extra field", () => {
    expect(() => parseManualWorkDto({ ...dto, unexpected: 1 })).toThrow();
  });

  it("rejects a missing revision", () => {
    const { revision: _revision, ...withoutRevision } = dto;
    expect(() => parseManualWorkDto(withoutRevision)).toThrow();
  });
});
