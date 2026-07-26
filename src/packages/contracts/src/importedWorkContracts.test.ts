import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import { MAX_WORK_CONTENT_REVISION } from "./manualWorkContracts.js";
import {
  parseAddImportedWorkSectionRequest,
  parseCorrectImportedWorkContentRequest,
  parseImportedWorkDto,
  parseImportedWorkUnitDto
} from "./importedWorkContracts.js";

// #762 boundary validation for the imported-Work correction API. The parsers are the single trust boundary
// between untrusted request/response payloads and the typed server/client code, so these prove each accepts
// a well-formed value and rejects the malformed, out-of-range, or extra-field shapes an attacker or a bug
// could send.

const document = createTextDocument("A corrected passage.");

const dto = {
  correctedAt: "2026-07-01T10:00:00.000Z",
  document,
  entryId: "work-1",
  language: "en" as const,
  revision: 3,
  sections: [
    { orderIndex: 0, unitEntryId: "unit-1" },
    { headingLevel: 1, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-2" }
  ],
  title: "Imported source",
  unitEntryId: "unit-1",
  workType: "book" as const
};

describe("parseCorrectImportedWorkContentRequest", () => {
  it("accepts a document with its revision token", () => {
    const request = { document, revision: 2 };
    expect(parseCorrectImportedWorkContentRequest(request)).toEqual(request);
  });

  it("accepts the initial revision 0", () => {
    expect(parseCorrectImportedWorkContentRequest({ document, revision: 0 })).toEqual({
      document,
      revision: 0
    });
  });

  it("rejects a request missing its revision", () => {
    expect(() => parseCorrectImportedWorkContentRequest({ document })).toThrow();
  });

  it("rejects a negative revision", () => {
    expect(() => parseCorrectImportedWorkContentRequest({ document, revision: -1 })).toThrow();
  });

  it("rejects a revision above the accepted ceiling", () => {
    expect(() =>
      parseCorrectImportedWorkContentRequest({ document, revision: MAX_WORK_CONTENT_REVISION + 1 })
    ).toThrow();
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseCorrectImportedWorkContentRequest({ document: { type: "not-a-doc" }, revision: 1 })
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() =>
      parseCorrectImportedWorkContentRequest({ document, extra: true, revision: 1 })
    ).toThrow();
  });
});

describe("parseAddImportedWorkSectionRequest", () => {
  it("accepts a revision token", () => {
    expect(parseAddImportedWorkSectionRequest({ revision: 4 })).toEqual({ revision: 4 });
  });

  it("rejects a request missing its revision", () => {
    expect(() => parseAddImportedWorkSectionRequest({})).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() => parseAddImportedWorkSectionRequest({ extra: 1, revision: 0 })).toThrow();
  });
});

describe("parseImportedWorkDto", () => {
  it("accepts a fully-formed imported Work DTO", () => {
    expect(parseImportedWorkDto(dto)).toEqual(dto);
  });

  it("accepts a still-uncorrected Work with a null correctedAt", () => {
    const uncorrected = { ...dto, correctedAt: null };
    expect(parseImportedWorkDto(uncorrected)).toEqual(uncorrected);
  });

  it("rejects a DTO missing correctedAt", () => {
    const { correctedAt: _correctedAt, ...withoutMarker } = dto;
    expect(() => parseImportedWorkDto(withoutMarker)).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() => parseImportedWorkDto({ ...dto, createdAt: "2026-07-01T10:00:00.000Z" })).toThrow();
  });
});

describe("parseImportedWorkUnitDto", () => {
  it("accepts a section document payload", () => {
    const unit = { document, unitEntryId: "unit-2" };
    expect(parseImportedWorkUnitDto(unit)).toEqual(unit);
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseImportedWorkUnitDto({ document: { type: "nope" }, unitEntryId: "unit-2" })
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() => parseImportedWorkUnitDto({ document, extra: 1, unitEntryId: "unit-2" })).toThrow();
  });
});
