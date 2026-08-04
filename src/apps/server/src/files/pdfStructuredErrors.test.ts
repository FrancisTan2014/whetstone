import { describe, expect, it } from "vitest";

import {
  artifactIntegrityFailure,
  cancelledFailure,
  childCrashFailure,
  classifyWorkerExit,
  cleanupFailure,
  conversionIncompleteFailure,
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
  WORKER_EXIT_CONVERSION_INCOMPLETE,
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
      cleanupFailure("EACCES"),
      conversionIncompleteFailure(),
      artifactIntegrityFailure("sha256 mismatch")
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
    expect(artifactIntegrityFailure("sha256 mismatch").kind).toBe("artifact_integrity");
    expect(artifactIntegrityFailure("sha256 mismatch").what).toContain("sha256 mismatch");
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
    // A degraded conversion is its OWN kind (#832), never folded into `malformed`: the file parsed
    // fine, the run lost pages, and an operator must be able to tell those apart.
    expect(classifyWorkerExit({ ...base, code: WORKER_EXIT_CONVERSION_INCOMPLETE }).kind).toBe(
      "conversion_incomplete"
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

// The worker exit codes are a cross-LANGUAGE wire contract, mirrored verbatim by EXIT_* in the Python
// worker (src/apps/server/src/files/pdf_to_docling.py), which reports an outcome via sys.exit(EXIT_*).
// classifyWorkerExit above switches on these integers, so the NUMBER each constant carries — not the
// symbol — is what crosses the process boundary. Every test above routes an outcome through the
// WORKER_EXIT_* symbols, so changing the integer a symbol carries leaves them all green while silently
// breaking classification (the gap mutation testing surfaced in the #839 review). This pins the literal
// integers so a divergence introduced on the TypeScript side fails here and forces the matching,
// deliberate edit to EXIT_* in the worker.
describe("worker exit-code wire contract", () => {
  it("pins each WORKER_EXIT_* to the integer the Python worker emits", () => {
    // Codes 3–9 are the failures the worker self-classifies (branched on above); 2 is a usage error.
    // To change one, change the matching EXIT_* in pdf_to_docling.py in the SAME commit, then update
    // this pin — never renumber to "tidy up", because these integers travel on the wire.
    expect(
      {
        WORKER_EXIT_USAGE,
        WORKER_EXIT_MISSING_DEPENDENCY,
        WORKER_EXIT_CONVERSION_FAILED,
        WORKER_EXIT_PASSWORD_REQUIRED,
        WORKER_EXIT_UNSUPPORTED_SCHEMA,
        WORKER_EXIT_MEMORY,
        WORKER_EXIT_MEMORY_CEILING_UNSUPPORTED,
        WORKER_EXIT_CONVERSION_INCOMPLETE
      },
      "PDF worker exit-code wire contract drift: a WORKER_EXIT_* constant no longer matches the integer " +
        "pdf_to_docling.py emits via sys.exit(EXIT_*). classifyWorkerExit switches on these numbers, so " +
        "changing one side alone makes the adapter misclassify a real worker outcome (e.g. read a " +
        "refused, incomplete conversion as a malformed file). Change BOTH sides in the same commit: " +
        "EXIT_* in src/apps/server/src/files/pdf_to_docling.py and WORKER_EXIT_* here."
    ).toEqual({
      WORKER_EXIT_USAGE: 2,
      WORKER_EXIT_MISSING_DEPENDENCY: 3,
      WORKER_EXIT_CONVERSION_FAILED: 4,
      WORKER_EXIT_PASSWORD_REQUIRED: 5,
      WORKER_EXIT_UNSUPPORTED_SCHEMA: 6,
      WORKER_EXIT_MEMORY: 7,
      WORKER_EXIT_MEMORY_CEILING_UNSUPPORTED: 8,
      WORKER_EXIT_CONVERSION_INCOMPLETE: 9
    });
  });
});
