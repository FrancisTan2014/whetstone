import { MAX_STAGED_BYTES } from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { readServerConfig } from "./serverConfig.js";

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
