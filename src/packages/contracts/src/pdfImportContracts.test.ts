import { describe, expect, it } from "vitest";

import {
  parsePdfImportStartedDto,
  parsePdfImportStatusDto,
  pdfImportAttemptStateSchema,
  pdfImportFailureDtoSchema,
  pdfImportStageDtoSchema,
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
      pdfImportFailureDtoSchema.safeParse({ kind: "k", message: "m", remedy: "r", extra: 1 }).success
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
