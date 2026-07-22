import { describe, expect, it } from "vitest";

import {
  parsePdfImportBeginResultDto,
  parsePdfImportStartedDto,
  parsePdfImportStatusDto,
  parsePdfImportViewDto,
  pdfImportAttemptStateSchema,
  pdfImportFailureDtoSchema,
  pdfImportPublicationOutcomeDtoSchema,
  pdfImportStageDtoSchema,
  pdfImportStartMetadataSchema,
  type PdfImportStatusDto
} from "./pdfImportContracts.js";

const hexHash = "a".repeat(64);

const baseStatus: PdfImportStatusDto = {
  adapterFingerprint: null,
  attemptId: "attempt-1",
  completedPages: 0,
  completedRanges: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  failure: null,
  heartbeatAt: null,
  sourceHash: hexHash,
  stage: { bound: true },
  state: "queued",
  totalPages: null,
  totalRanges: null,
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("pdfImportAttemptStateSchema", () => {
  it("accepts every domain state and rejects an unknown one", () => {
    expect(pdfImportAttemptStateSchema.parse("running")).toBe("running");
    expect(pdfImportAttemptStateSchema.safeParse("nope").success).toBe(false);
  });
});

describe("pdfImportFailureDtoSchema", () => {
  it("accepts a fully-populated typed failure", () => {
    const failure = { kind: "too_large", message: "the file is too large.", remedy: "split it." };
    expect(pdfImportFailureDtoSchema.parse(failure)).toEqual(failure);
  });

  it("rejects empty fields and unknown keys", () => {
    expect(
      pdfImportFailureDtoSchema.safeParse({ kind: "", message: "m", remedy: "r" }).success
    ).toBe(false);
    expect(
      pdfImportFailureDtoSchema.safeParse({ kind: "k", message: "m", remedy: "r", extra: 1 })
        .success
    ).toBe(false);
  });
});

describe("pdfImportStageDtoSchema", () => {
  it("reports stage presence only", () => {
    expect(pdfImportStageDtoSchema.parse({ bound: false })).toEqual({ bound: false });
  });
});

describe("parsePdfImportStatusDto", () => {
  it("accepts a valid status with a probed failure", () => {
    const status: PdfImportStatusDto = {
      ...baseStatus,
      adapterFingerprint: "docling@2.114.0/core@2.87.1/schema@1.10.0",
      completedPages: 10,
      completedRanges: 1,
      failure: { kind: "malformed", message: "bad pdf.", remedy: "re-export it." },
      heartbeatAt: "2026-01-01T00:01:00.000Z",
      state: "failed",
      totalPages: 50,
      totalRanges: 2
    };
    expect(parsePdfImportStatusDto(status)).toEqual(status);
  });

  it("rejects a non-hex source hash", () => {
    expect(() => parsePdfImportStatusDto({ ...baseStatus, sourceHash: "not-hex" })).toThrow();
  });
});

describe("parsePdfImportStartedDto", () => {
  it("accepts the created attempt id plus its initial status", () => {
    const started = { attemptId: "attempt-1", status: baseStatus };
    expect(parsePdfImportStartedDto(started)).toEqual(started);
  });

  it("rejects an empty attempt id", () => {
    expect(() => parsePdfImportStartedDto({ attemptId: "", status: baseStatus })).toThrow();
  });
});

describe("pdfImportStartMetadataSchema", () => {
  it("defaults the three optional intent fields to null and requires a file name", () => {
    expect(pdfImportStartMetadataSchema.parse({ fileName: "reading.pdf" })).toEqual({
      enteredAuthor: null,
      enteredLanguage: null,
      enteredTitle: null,
      fileName: "reading.pdf"
    });
  });

  it("keeps entered values and rejects a missing file name or unknown key", () => {
    expect(
      pdfImportStartMetadataSchema.parse({
        enteredAuthor: "Jane",
        enteredLanguage: "en",
        enteredTitle: "Chosen",
        fileName: "x.pdf"
      })
    ).toEqual({
      enteredAuthor: "Jane",
      enteredLanguage: "en",
      enteredTitle: "Chosen",
      fileName: "x.pdf"
    });
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "" }).success).toBe(false);
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "x.pdf", extra: 1 }).success).toBe(
      false
    );
  });
});

describe("parsePdfImportBeginResultDto", () => {
  it("accepts a reopened result and a queued result", () => {
    expect(parsePdfImportBeginResultDto({ outcome: "reopened", workEntryId: "work-1" })).toEqual({
      outcome: "reopened",
      workEntryId: "work-1"
    });
    const queued = { attemptId: "attempt-1", outcome: "queued", status: baseStatus };
    expect(parsePdfImportBeginResultDto(queued)).toEqual(queued);
  });

  it("rejects an unknown outcome and a reopened result without a work id", () => {
    expect(() => parsePdfImportBeginResultDto({ outcome: "nope" })).toThrow();
    expect(() => parsePdfImportBeginResultDto({ outcome: "reopened", workEntryId: "" })).toThrow();
  });
});

describe("pdfImportPublicationOutcomeDtoSchema", () => {
  it("accepts each publication outcome variant", () => {
    expect(pdfImportPublicationOutcomeDtoSchema.parse({ status: "none" })).toEqual({
      status: "none"
    });
    expect(pdfImportPublicationOutcomeDtoSchema.parse({ status: "pending" })).toEqual({
      status: "pending"
    });
    expect(
      pdfImportPublicationOutcomeDtoSchema.parse({ status: "published", workEntryId: "work-1" })
    ).toEqual({ status: "published", workEntryId: "work-1" });
    expect(
      pdfImportPublicationOutcomeDtoSchema.parse({ pagesNeedingOcr: 3, status: "ocr_required" })
    ).toEqual({ pagesNeedingOcr: 3, status: "ocr_required" });
    expect(pdfImportPublicationOutcomeDtoSchema.parse({ status: "no_content" })).toEqual({
      status: "no_content"
    });
    expect(
      pdfImportPublicationOutcomeDtoSchema.parse({
        status: "image_unsupported",
        unpreservableImages: 2
      })
    ).toEqual({ status: "image_unsupported", unpreservableImages: 2 });
  });

  it("rejects a non-positive OCR page count", () => {
    expect(
      pdfImportPublicationOutcomeDtoSchema.safeParse({ pagesNeedingOcr: 0, status: "ocr_required" })
        .success
    ).toBe(false);
  });

  it("rejects a non-positive unpreservable-image count", () => {
    expect(
      pdfImportPublicationOutcomeDtoSchema.safeParse({
        status: "image_unsupported",
        unpreservableImages: 0
      }).success
    ).toBe(false);
  });
});

describe("parsePdfImportViewDto", () => {
  it("accepts a view pairing execution status with a publication outcome", () => {
    const view = { publication: { status: "pending" }, status: baseStatus };
    expect(parsePdfImportViewDto(view)).toEqual(view);
  });

  it("rejects a view missing its publication outcome", () => {
    expect(() => parsePdfImportViewDto({ status: baseStatus })).toThrow();
  });
});
