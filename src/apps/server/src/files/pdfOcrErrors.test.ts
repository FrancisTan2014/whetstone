import { describe, expect, it } from "vitest";

import {
  classifyOcrmypdfFailure,
  ocrCleanupFailure,
  ocrGeometryFailure,
  ocrLanguageMissingFailure,
  ocrNativeTextFailure,
  ocrOutputValidationFailure,
  ocrRoutingMismatchFailure,
  ocrStageWriteFailure,
  ocrToolMissingFailure,
  ocrToolUnresponsiveFailure
} from "./pdfOcrErrors.js";

describe("classifyOcrmypdfFailure", () => {
  const timeoutMs = 45_000;

  it("maps a missing toolchain run to tool_missing", () => {
    expect(classifyOcrmypdfFailure({ status: "tool_missing" }, timeoutMs).kind).toBe(
      "tool_missing"
    );
  });

  it("maps a timed-out run to timeout, naming the ceiling", () => {
    const failure = classifyOcrmypdfFailure({ status: "timed_out" }, timeoutMs);
    expect(failure.kind).toBe("timeout");
    expect(failure.what).toContain("45000ms");
  });

  it("maps a cancelled run to cancelled", () => {
    expect(classifyOcrmypdfFailure({ status: "cancelled" }, timeoutMs).kind).toBe("cancelled");
  });

  it("maps OCRmyPDF's missing-dependency exit (3) to tool_missing", () => {
    expect(classifyOcrmypdfFailure({ status: "exit", code: 3, signal: null }, timeoutMs).kind).toBe(
      "tool_missing"
    );
  });

  it("maps an input-file (2) or encrypted (8) exit to unsupported_input", () => {
    expect(classifyOcrmypdfFailure({ status: "exit", code: 2, signal: null }, timeoutMs).kind).toBe(
      "unsupported_input"
    );
    expect(classifyOcrmypdfFailure({ status: "exit", code: 8, signal: null }, timeoutMs).kind).toBe(
      "unsupported_input"
    );
  });

  it("maps an invalid-output (4) or PDF/A (10) exit to output_validation", () => {
    expect(classifyOcrmypdfFailure({ status: "exit", code: 4, signal: null }, timeoutMs).kind).toBe(
      "output_validation"
    );
    expect(
      classifyOcrmypdfFailure({ status: "exit", code: 10, signal: null }, timeoutMs).kind
    ).toBe("output_validation");
  });

  it("maps any other non-zero exit code to child_crash", () => {
    for (const code of [1, 5, 7, 9, 15]) {
      expect(classifyOcrmypdfFailure({ status: "exit", code, signal: null }, timeoutMs).kind).toBe(
        "child_crash"
      );
    }
  });

  it("maps a SIGKILL-terminated child with no exit code to memory (OOM)", () => {
    expect(
      classifyOcrmypdfFailure({ status: "exit", code: null, signal: "SIGKILL" }, timeoutMs).kind
    ).toBe("memory");
  });

  it("maps another terminating signal with no exit code to child_crash", () => {
    const failure = classifyOcrmypdfFailure(
      { status: "exit", code: null, signal: "SIGTERM" },
      timeoutMs
    );
    expect(failure.kind).toBe("child_crash");
    expect(failure.what).toContain("SIGTERM");
  });

  it("maps a child with neither exit code nor signal to child_crash", () => {
    const failure = classifyOcrmypdfFailure(
      { status: "exit", code: null, signal: null },
      timeoutMs
    );
    expect(failure.kind).toBe("child_crash");
    expect(failure.what).toContain("without a code or signal");
  });
});

describe("named OCR failures carry an actionable remedy", () => {
  it("language_missing names the missing packs in both what and remedy", () => {
    const failure = ocrLanguageMissingFailure(["chi_sim", "eng"]);
    expect(failure.kind).toBe("language_missing");
    expect(failure.what).toContain("chi_sim, eng");
    expect(failure.remedy).toContain("chi_sim, eng");
  });

  it("geometry carries the detail and refuses re-ingestion", () => {
    const failure = ocrGeometryFailure("page 2 rotation changed");
    expect(failure.kind).toBe("geometry");
    expect(failure.what).toContain("page 2 rotation changed");
    expect(failure.remedy).toContain("Do not re-ingest");
  });

  it("native_text names the corrupted page", () => {
    const failure = ocrNativeTextFailure(3);
    expect(failure.kind).toBe("native_text");
    expect(failure.what).toContain("page 3");
  });

  it("output_validation and cleanup carry their detail", () => {
    expect(ocrOutputValidationFailure("bad pdf").what).toContain("bad pdf");
    expect(ocrCleanupFailure("EACCES").what).toContain("EACCES");
  });

  it("stage_write carries the detail and points at the stage directory", () => {
    const failure = ocrStageWriteFailure("ENOSPC");
    expect(failure.kind).toBe("stage_write");
    expect(failure.what).toContain("ENOSPC");
    expect(failure.remedy).toContain("stage directory");
  });

  it("routing_mismatch carries the detail and tells the caller to re-derive from a fresh probe", () => {
    const failure = ocrRoutingMismatchFailure("probe says scanned, routing says native");
    expect(failure.kind).toBe("routing_mismatch");
    expect(failure.what).toContain("probe says scanned, routing says native");
    expect(failure.remedy).toContain("Re-derive");
  });

  it("tool_missing offers the install/setup remedy", () => {
    const failure = ocrToolMissingFailure();
    expect(failure.kind).toBe("tool_missing");
    expect(failure.remedy).toContain("setup:pdf");
  });

  it("tool_unresponsive is distinct from tool_missing: retryable, never the install remedy", () => {
    // #788: a present-but-slow toolchain must not be told to reinstall.
    for (const reason of ["timeout", "launch_failure", "version_probe_failed"] as const) {
      const failure = ocrToolUnresponsiveFailure(reason, "detail-string");
      expect(failure.kind).toBe("tool_unresponsive");
      expect(failure.what).toContain("installed");
      expect(failure.what).toContain("detail-string");
      expect(failure.remedy).toContain("start the import again");
      expect(failure.remedy).not.toContain("setup:pdf");
    }
  });

  it("tool_unresponsive falls back to the raw reason when it is not a known one", () => {
    const failure = ocrToolUnresponsiveFailure("weird_reason" as "timeout", "d");
    expect(failure.what).toContain("weird_reason");
  });
});
