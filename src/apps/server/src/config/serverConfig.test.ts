import { MAX_STAGED_BYTES } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PDF_TIMEOUT_MS,
  defaultStructuredPdfMemoryMib,
  readServerConfig,
  resolveStructuredPdfMemoryMib,
  resolveStructuredPdfTimeoutMs
} from "./serverConfig.js";

describe("readServerConfig PDF upload limit", () => {
  it("defaults the PDF upload limit to the structured staging bound, not the smaller EPUB limit", () => {
    const config = readServerConfig({});
    // The born-digital PDF front door must accept every supported PDF up to the contract's staging
    // bound, so a 50-128 MiB PDF is not rejected early by the unrelated EPUB body limit.
    expect(config.pdfUploadLimitBytes).toBe(MAX_STAGED_BYTES);
    expect(config.pdfUploadLimitBytes).toBeGreaterThan(config.epubUploadLimitBytes);
  });

  it("honors a valid PDF_UPLOAD_LIMIT_BYTES override independently of the EPUB limit", () => {
    const config = readServerConfig({ PDF_UPLOAD_LIMIT_BYTES: "12345" });
    expect(config.pdfUploadLimitBytes).toBe(12345);
    expect(config.epubUploadLimitBytes).toBe(50 * 1024 * 1024);
  });

  it("rejects a non-positive or non-integer PDF_UPLOAD_LIMIT_BYTES", () => {
    expect(() => readServerConfig({ PDF_UPLOAD_LIMIT_BYTES: "0" })).toThrow(
      "PDF_UPLOAD_LIMIT_BYTES must be a positive integer number of bytes."
    );
    expect(() => readServerConfig({ PDF_UPLOAD_LIMIT_BYTES: "not-a-number" })).toThrow(
      "PDF_UPLOAD_LIMIT_BYTES must be a positive integer number of bytes."
    );
  });
});

describe("readServerConfig structured PDF memory ceiling", () => {
  it("defaults to 2,048 MiB on POSIX", () => {
    // Docling's POSIX-calibrated committed footprint fits the historical 2 GiB address-space ceiling.
    expect(readServerConfig({}, "linux").pdfStructuredMemoryMib).toBe(2048);
    expect(readServerConfig({}, "darwin").pdfStructuredMemoryMib).toBe(2048);
    expect(defaultStructuredPdfMemoryMib("linux")).toBe(2048);
  });

  it("defaults to 6,144 MiB on Windows", () => {
    // Docling's torch/MKL runtime commits ~2x on Windows (measured ~3.9 GiB peak, #782); 6 GiB is a hard
    // single-admission bound with headroom above that floor, never the survival-threshold 4 GiB.
    expect(readServerConfig({}, "win32").pdfStructuredMemoryMib).toBe(6144);
    expect(defaultStructuredPdfMemoryMib("win32")).toBe(6144);
  });

  it("honors an explicit PDF_STRUCTURED_MEMORY_MIB override on every platform", () => {
    expect(
      readServerConfig({ PDF_STRUCTURED_MEMORY_MIB: "4096" }, "linux").pdfStructuredMemoryMib
    ).toBe(4096);
    expect(
      readServerConfig({ PDF_STRUCTURED_MEMORY_MIB: "4096" }, "win32").pdfStructuredMemoryMib
    ).toBe(4096);
    // The pure resolver is the single owner both production and the #779 harness consume.
    expect(resolveStructuredPdfMemoryMib("3072", "win32")).toBe(3072);
    expect(resolveStructuredPdfMemoryMib(undefined, "win32")).toBe(6144);
    expect(resolveStructuredPdfMemoryMib(undefined, "linux")).toBe(2048);
  });

  it("rejects a non-positive or non-integer PDF_STRUCTURED_MEMORY_MIB", () => {
    expect(() => readServerConfig({ PDF_STRUCTURED_MEMORY_MIB: "0" }, "win32")).toThrow(
      "PDF_STRUCTURED_MEMORY_MIB must be a positive integer number of MiB."
    );
    expect(() => resolveStructuredPdfMemoryMib("-1", "linux")).toThrow(
      "PDF_STRUCTURED_MEMORY_MIB must be a positive integer number of MiB."
    );
    expect(() => resolveStructuredPdfMemoryMib("not-a-number", "linux")).toThrow(
      "PDF_STRUCTURED_MEMORY_MIB must be a positive integer number of MiB."
    );
  });
});

describe("readServerConfig structured PDF timeout", () => {
  it("defaults the worker timeout to the production 600000 ms bound", () => {
    // The single owner both the live import lane and the #779 corpus harness consume, so a gate run kills a
    // slow spawn at the exact point production does — never a longer duplicated default. #789 recalibrated it
    // from 180000 ms (born-digital only) so a smallest-scale scanned page's slower OCR-derived conversion is
    // not killed mid-flight, while it stays a hard bound below the retired 15-minute harness reference.
    expect(DEFAULT_PDF_TIMEOUT_MS).toBe(600_000);
    expect(readServerConfig({}).pdfTimeoutMs).toBe(600_000);
    expect(resolveStructuredPdfTimeoutMs(undefined)).toBe(600_000);
    // Still a hard bound, strictly under the retired 15-minute harness default the gate must not use.
    expect(DEFAULT_PDF_TIMEOUT_MS).toBeLessThan(15 * 60 * 1000);
  });

  it("honors a valid PDF_TIMEOUT_MS override", () => {
    expect(readServerConfig({ PDF_TIMEOUT_MS: "90000" }).pdfTimeoutMs).toBe(90000);
    expect(resolveStructuredPdfTimeoutMs("90000")).toBe(90000);
  });

  it("rejects a non-positive or non-integer PDF_TIMEOUT_MS", () => {
    expect(() => readServerConfig({ PDF_TIMEOUT_MS: "0" })).toThrow(
      "PDF_TIMEOUT_MS must be a positive integer number of milliseconds."
    );
    expect(() => resolveStructuredPdfTimeoutMs("-5")).toThrow(
      "PDF_TIMEOUT_MS must be a positive integer number of milliseconds."
    );
    expect(() => resolveStructuredPdfTimeoutMs("not-a-number")).toThrow(
      "PDF_TIMEOUT_MS must be a positive integer number of milliseconds."
    );
  });
});

describe("readServerConfig work-creation stage directory", () => {
  it("defaults the creation-review stage to a dedicated non-backed-up data path", () => {
    // The stage lives under .data (like the PDF import stage) and is deliberately outside the backed-up
    // source/image roots, so a cancelled or expired attempt's bytes are freed without entering a backup.
    expect(readServerConfig({}).workCreationStageDir).toBe("./.data/work-creation-stages");
  });

  it("honors a WORK_CREATION_STAGE_DIR override", () => {
    expect(readServerConfig({ WORK_CREATION_STAGE_DIR: "/srv/stage" }).workCreationStageDir).toBe(
      "/srv/stage"
    );
  });
});
