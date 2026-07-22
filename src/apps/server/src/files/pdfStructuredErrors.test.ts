import { describe, expect, it } from "vitest";

import {
  cancelledFailure,
  childCrashFailure,
  classifyWorkerExit,
  cleanupFailure,
  forbiddenHandleFailure,
  malformedFailure,
  memoryCeilingUnsupportedFailure,
  memoryFailure,
  passwordRequiredFailure,
  timeoutFailure,
  toolMissingFailure,
  tooLargeFailure,
  tooManyPagesFailure,
  unsupportedSchemaFailure,
  WORKER_EXIT_CONVERSION_FAILED,
  WORKER_EXIT_MEMORY,
  WORKER_EXIT_MEMORY_CEILING_UNSUPPORTED,
  WORKER_EXIT_MISSING_DEPENDENCY,
  WORKER_EXIT_PASSWORD_REQUIRED,
  WORKER_EXIT_UNSUPPORTED_SCHEMA,
  WORKER_EXIT_USAGE
} from "./pdfStructuredErrors.js";

describe("named failure constructors", () => {
  it("each carries its kind, a specific `what`, and an actionable `remedy`", () => {
    const failures = [
      tooLargeFailure(200, 100),
      tooManyPagesFailure(5000, 3000),
      passwordRequiredFailure(),
      malformedFailure("bad xref"),
      unsupportedSchemaFailure("9.9.9"),
      toolMissingFailure(),
      forbiddenHandleFailure(),
      timeoutFailure(1000),
      memoryFailure(),
      memoryCeilingUnsupportedFailure(),
      childCrashFailure("segfault"),
      cancelledFailure(),
      cleanupFailure("EACCES")
    ];
    for (const failure of failures) {
      expect(failure.kind.length).toBeGreaterThan(0);
      expect(failure.what.length).toBeGreaterThan(0);
      expect(failure.remedy.length).toBeGreaterThan(0);
      expect(Object.isFrozen(failure)).toBe(true);
    }
  });

  it("embeds the offending values in the message", () => {
    expect(tooLargeFailure(200, 100).what).toContain("200");
    expect(tooManyPagesFailure(5000, 3000).what).toContain("5000");
    expect(unsupportedSchemaFailure("9.9.9").what).toContain("9.9.9");
    expect(timeoutFailure(1000).what).toContain("1000");
    expect(malformedFailure("bad xref").what).toContain("bad xref");
    expect(childCrashFailure("segfault").what).toContain("segfault");
    expect(cleanupFailure("EACCES").what).toContain("EACCES");
  });
});

describe("classifyWorkerExit", () => {
  const base = { code: null, signal: null, timedOut: false, cancelled: false, timeoutMs: 1000 };

  it("prefers cancellation over every other signal", () => {
    expect(
      classifyWorkerExit({ ...base, cancelled: true, timedOut: true, code: WORKER_EXIT_MEMORY })
        .kind
    ).toBe("cancelled");
  });

  it("reports a wall-clock timeout when not cancelled", () => {
    expect(classifyWorkerExit({ ...base, timedOut: true }).kind).toBe("timeout");
  });

  it("maps each self-classifying worker exit code to its failure", () => {
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_MISSING_DEPENDENCY }).kind).toBe(
      "tool_missing"
    );
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_PASSWORD_REQUIRED }).kind).toBe(
      "password_required"
    );
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_UNSUPPORTED_SCHEMA }).kind).toBe(
      "unsupported_schema"
    );
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_MEMORY }).kind).toBe("memory");
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_MEMORY_CEILING_UNSUPPORTED }).kind).toBe(
      "memory_ceiling_unsupported"
    );
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_CONVERSION_FAILED }).kind).toBe(
      "malformed"
    );
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_USAGE }).kind).toBe("malformed");
  });

  it("treats an unrecognized exit code as a child crash naming the code", () => {
    const failure = classifyWorkerExit({ ...base, code: 137 });
    expect(failure.kind).toBe("child_crash");
    expect(failure.what).toContain("137");
  });

  it("treats a terminating signal as a child crash naming the signal", () => {
    const failure = classifyWorkerExit({ ...base, code: null, signal: "SIGSEGV" });
    expect(failure.kind).toBe("child_crash");
    expect(failure.what).toContain("SIGSEGV");
  });
});
