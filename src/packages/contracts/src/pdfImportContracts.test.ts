import { describe, expect, it } from "vitest";

import {
  parsePdfImportBeginResultDto,
  parsePdfImportStartedDto,
  parsePdfImportStatusDto,
  parsePdfImportViewDto,
  pdfImportAttemptStateSchema,
  pdfImportFailureDtoSchema,
  pdfImportPhaseSchema,
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
  phase: null,
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

  it("accepts a running attempt's durable phase and rejects an unknown one", () => {
    expect(
      parsePdfImportStatusDto({ ...baseStatus, state: "running", phase: "ocr" })
    ).toMatchObject({
      phase: "ocr"
    });
    expect(pdfImportPhaseSchema.parse("structured")).toBe("structured");
    expect(pdfImportPhaseSchema.safeParse("nope").success).toBe(false);
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
  it("defaults the three optional intent fields and the OCR override to null and requires a file name", () => {
    expect(pdfImportStartMetadataSchema.parse({ fileName: "reading.pdf" })).toEqual({
      enteredAuthor: null,
      enteredLanguage: null,
      enteredTitle: null,
      fileName: "reading.pdf",
      ocrLanguageOverride: null
    });
  });

  it("keeps entered values and rejects a missing file name or unknown key", () => {
    expect(
      pdfImportStartMetadataSchema.parse({
        enteredAuthor: "Jane",
        enteredLanguage: "en",
        enteredTitle: "Chosen",
        fileName: "x.pdf",
        ocrLanguageOverride: "zh-CN"
      })
    ).toEqual({
      enteredAuthor: "Jane",
      enteredLanguage: "en",
      enteredTitle: "Chosen",
      fileName: "x.pdf",
      ocrLanguageOverride: "zh-CN"
    });
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "" }).success).toBe(false);
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "x.pdf", extra: 1 }).success).toBe(
      false
    );
  });

  it("accepts every Work language as the OCR override and rejects any other value", () => {
    for (const override of ["en", "zh-CN", "zh-TW"] as const) {
      expect(
        pdfImportStartMetadataSchema.parse({ fileName: "x.pdf", ocrLanguageOverride: override })
          .ocrLanguageOverride
      ).toBe(override);
    }
    expect(
      pdfImportStartMetadataSchema.safeParse({ fileName: "x.pdf", ocrLanguageOverride: "fr" }).success
    ).toBe(false);
    expect(
      pdfImportStartMetadataSchema.safeParse({ fileName: "x.pdf", ocrLanguageOverride: "" }).success
    ).toBe(false);
  });

  it("sanitizes a file name to a safe basename, stripping any directory path", () => {
    expect(
      pdfImportStartMetadataSchema.parse({ fileName: "C:\\Users\\me\\secret.pdf" }).fileName
    ).toBe("secret.pdf");
    expect(pdfImportStartMetadataSchema.parse({ fileName: "/home/me/secret.pdf" }).fileName).toBe(
      "secret.pdf"
    );
    expect(pdfImportStartMetadataSchema.parse({ fileName: "a/../b/reading.pdf" }).fileName).toBe(
      "reading.pdf"
    );
    // Control characters an OS path never legitimately holds are stripped.
    expect(pdfImportStartMetadataSchema.parse({ fileName: "read\u0007ing.pdf" }).fileName).toBe(
      "reading.pdf"
    );
  });

  it("rejects a file name that reduces to nothing usable (a bare path or separator)", () => {
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "/home/me/" }).success).toBe(false);
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: ".." }).success).toBe(false);
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "a/b/.." }).success).toBe(false);
    expect(pdfImportStartMetadataSchema.safeParse({ fileName: "." }).success).toBe(false);
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
      pdfImportPublicationOutcomeDtoSchema.parse({
        pagesNeedingOcr: 3,
        status: "ocr_validation_failed"
      })
    ).toEqual({ pagesNeedingOcr: 3, status: "ocr_validation_failed" });
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
      pdfImportPublicationOutcomeDtoSchema.safeParse({
        pagesNeedingOcr: 0,
        status: "ocr_validation_failed"
      }).success
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
