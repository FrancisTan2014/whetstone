import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  MAX_WORK_CONTENT_REVISION,
  parseAddManualWorkSectionRequest,
  parseManualWorkDto,
  parseManualWorkUnitDto,
  parseUpdateManualWorkContentRequest
} from "./manualWorkContracts.js";

const document = createTextDocument("A curated passage.");

const dto = {
  createdAt: "2026-07-01T10:00:00.000Z",
  document,
  entryId: "work-1",
  language: "en" as const,
  revision: 3,
  sections: [
    { orderIndex: 0, unitEntryId: "unit-1" },
    { headingLevel: 1, orderIndex: 1, title: "Chapter One", unitEntryId: "unit-2" }
  ],
  title: "My source",
  unitEntryId: "unit-1",
  updatedAt: "2026-07-01T11:00:00.000Z",
  workType: "book" as const
};

describe("parseUpdateManualWorkContentRequest", () => {
  it("accepts a document with its revision token", () => {
    const request = { document, revision: 2 };
    expect(parseUpdateManualWorkContentRequest(request)).toEqual(request);
  });

  it("accepts the initial revision 0", () => {
    const request = { document, revision: 0 };
    expect(parseUpdateManualWorkContentRequest(request)).toEqual(request);
  });

  it("rejects a request missing its revision", () => {
    expect(() => parseUpdateManualWorkContentRequest({ document })).toThrow();
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseUpdateManualWorkContentRequest({ document: { type: "not-a-doc" }, revision: 1 })
    ).toThrow();
  });

  it("rejects a non-integer or negative revision", () => {
    expect(() => parseUpdateManualWorkContentRequest({ document, revision: 1.5 })).toThrow();
    expect(() => parseUpdateManualWorkContentRequest({ document, revision: -1 })).toThrow();
    expect(() => parseUpdateManualWorkContentRequest({ document, revision: "1" })).toThrow();
  });

  it("accepts the maximum PostgreSQL integer revision but rejects one beyond it", () => {
    const atMax = { document, revision: MAX_WORK_CONTENT_REVISION };
    expect(parseUpdateManualWorkContentRequest(atMax)).toEqual(atMax);
    // A safe JS integer just past the signed 32-bit range would overflow `work_meta.content_revision`;
    // it must be a typed boundary rejection, never reach the compare-and-set as a database error (#703).
    expect(() =>
      parseUpdateManualWorkContentRequest({ document, revision: MAX_WORK_CONTENT_REVISION + 1 })
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() =>
      parseUpdateManualWorkContentRequest({ document, extra: true, revision: 1 })
    ).toThrow();
  });
});

describe("parseManualWorkDto", () => {
  it("round-trips a full manual work with its document, revision, and sections", () => {
    expect(parseManualWorkDto(dto)).toEqual(dto);
  });

  it("rejects an unknown extra field", () => {
    expect(() => parseManualWorkDto({ ...dto, unexpected: 1 })).toThrow();
  });

  it("rejects a missing revision", () => {
    const { revision: _revision, ...withoutRevision } = dto;
    expect(() => parseManualWorkDto(withoutRevision)).toThrow();
  });

  it("rejects a missing sections list", () => {
    const { sections: _sections, ...withoutSections } = dto;
    expect(() => parseManualWorkDto(withoutSections)).toThrow();
  });

  it("rejects an unknown field inside a section", () => {
    expect(() =>
      parseManualWorkDto({ ...dto, sections: [{ extra: true, orderIndex: 0, unitEntryId: "u" }] })
    ).toThrow();
  });
});

describe("parseManualWorkUnitDto", () => {
  it("round-trips one section's document", () => {
    const unit = { document, unitEntryId: "unit-2" };
    expect(parseManualWorkUnitDto(unit)).toEqual(unit);
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseManualWorkUnitDto({ document: { type: "not-a-doc" }, unitEntryId: "u" })
    ).toThrow();
  });
});

describe("parseAddManualWorkSectionRequest", () => {
  it("accepts the loaded revision token", () => {
    expect(parseAddManualWorkSectionRequest({ revision: 4 })).toEqual({ revision: 4 });
  });

  it("rejects a request missing its revision", () => {
    expect(() => parseAddManualWorkSectionRequest({})).toThrow();
  });

  it("rejects a non-integer or negative revision", () => {
    expect(() => parseAddManualWorkSectionRequest({ revision: 1.5 })).toThrow();
    expect(() => parseAddManualWorkSectionRequest({ revision: -1 })).toThrow();
  });

  it("accepts the maximum PostgreSQL integer revision but rejects one beyond it", () => {
    expect(parseAddManualWorkSectionRequest({ revision: MAX_WORK_CONTENT_REVISION })).toEqual({
      revision: MAX_WORK_CONTENT_REVISION
    });
    expect(() =>
      parseAddManualWorkSectionRequest({ revision: MAX_WORK_CONTENT_REVISION + 1 })
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() => parseAddManualWorkSectionRequest({ extra: true, revision: 1 })).toThrow();
  });
});
