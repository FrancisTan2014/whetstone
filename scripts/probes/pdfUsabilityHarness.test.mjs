// Unit tests for the pure worker-run decisions the PDF usability harness relies on. The harness itself is
// coverage-excluded I/O orchestration (like scripts/probes/pdfStructuredCorpusProbe.mjs), but the
// OUTPUT-CAP INVARIANT it added must be falsifiable: an over-cap worker run has to be classified as a
// production failure, never parsed from truncated output and counted as usable. These tests pin (1) the
// bounded stdout accumulator's exact 64 MiB boundary, (2) runWorker killing the child and reporting
// `overCap` when the cap is exceeded, and (3) interpretWorkerRun mapping an over-cap run to an in-bound
// conversion failure that counts against the 95% gate.

import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_PDF_TIMEOUT_MS,
  resolveStructuredPdfTimeoutMs
} from "../../src/apps/server/src/config/serverConfig.js";
import {
  createBoundedStdout,
  EXIT,
  interpretWorkerRun,
  MAX_WORKER_OUTPUT_BYTES,
  runWorker
} from "./pdfUsabilityHarness.mjs";

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

function fakeIo(child) {
  return {
    spawn: () => child,
    createSampler: () => ({ stop: async () => null })
  };
}

describe("createBoundedStdout", () => {
  it("accumulates decoded output below the cap without overflowing", () => {
    const buffer = createBoundedStdout(16);
    expect(buffer.push(Buffer.from("hello "))).toBe(false);
    expect(buffer.push(Buffer.from("world"))).toBe(false);
    expect(buffer.overflowed).toBe(false);
    expect(buffer.text()).toBe("hello world");
  });

  it("does not overflow at exactly the cap, but does one byte past it", () => {
    const atCap = createBoundedStdout(4);
    expect(atCap.push(Buffer.from("abcd"))).toBe(false);
    expect(atCap.overflowed).toBe(false);
    expect(atCap.text()).toBe("abcd");

    const overCap = createBoundedStdout(4);
    expect(overCap.push(Buffer.from("abcde"))).toBe(true);
    expect(overCap.overflowed).toBe(true);
  });

  it("truncates and retains no further output once overflowed", () => {
    const buffer = createBoundedStdout(4);
    buffer.push(Buffer.from("ab"));
    expect(buffer.push(Buffer.from("cdef"))).toBe(true); // crosses the cap on this chunk
    expect(buffer.overflowed).toBe(true);
    // The chunk that crossed the cap is dropped, and later chunks are ignored — matching execFile's
    // maxBuffer truncation.
    expect(buffer.push(Buffer.from("ghij"))).toBe(true);
    expect(buffer.text()).toBe("ab");
  });

  it("defaults to the production 64 MiB output cap", () => {
    expect(MAX_WORKER_OUTPUT_BYTES).toBe(64 * 1024 * 1024);
    const buffer = createBoundedStdout();
    expect(buffer.push(Buffer.alloc(MAX_WORKER_OUTPUT_BYTES + 1))).toBe(true);
    expect(buffer.overflowed).toBe(true);
    expect(buffer.text()).toBe("");
  });
});

describe("runWorker output cap", () => {
  it("kills the child and reports overCap when stdout exceeds the cap", async () => {
    const child = fakeChild();
    const pending = runWorker("python", ["--range", "x", "1", "1"], 60_000, 2048, fakeIo(child));

    child.stdout.emit("data", Buffer.alloc(MAX_WORKER_OUTPUT_BYTES + 1));
    expect(child.killed).toBe(true);
    child.emit("close", null); // killed by signal -> null exit code

    const run = await pending;
    expect(run.overCap).toBe(true);
    expect(run.timedOut).toBe(false);
    expect(run.stdout).toBe("");
  });

  it("reports a clean run when stdout stays under the cap", async () => {
    const child = fakeChild();
    const pending = runWorker("python", ["--probe", "x"], 60_000, 2048, fakeIo(child));

    child.stdout.emit("data", Buffer.from("hello "));
    child.stdout.emit("data", Buffer.from("world"));
    expect(child.killed).toBe(false);
    child.emit("close", 0);

    const run = await pending;
    expect(run.overCap).toBe(false);
    expect(run.stdout).toBe("hello world");
    expect(run.code).toBe(EXIT.OK);
  });
});

describe("interpretWorkerRun", () => {
  const clean = { code: EXIT.OK, timedOut: false, overCap: false };
  it("returns null for a clean run so its stdout is parsed", () => {
    expect(interpretWorkerRun(clean, "probe")).toBeNull();
    expect(interpretWorkerRun(clean, "range")).toBeNull();
  });

  it("classifies an over-cap run as an in-bound conversion failure counted against the gate", () => {
    const result = interpretWorkerRun({ code: EXIT.OK, timedOut: false, overCap: true }, "range");
    expect(result.observation.kind).toBe("conversion_failed");
    expect(result.observation.detail).toContain(String(MAX_WORKER_OUTPUT_BYTES));
    // conversion_failed is NOT excluded by eligibility, so an over-cap file counts against the 95%
    // denominator as unsupported — never parsed as automatic/correctable.
    expect(result.abort).toBeUndefined();
  });

  it("treats a wall-clock timeout as a timeout, taking precedence over the exit code", () => {
    const result = interpretWorkerRun(
      { code: EXIT.CONVERSION_FAILED, timedOut: true, overCap: false },
      "range"
    );
    expect(result.observation.kind).toBe("timeout");
  });

  it("prefers over-cap over a non-OK exit code", () => {
    const result = interpretWorkerRun(
      { code: EXIT.CONVERSION_FAILED, timedOut: false, overCap: true },
      "range"
    );
    expect(result.observation.kind).toBe("conversion_failed");
    expect(result.observation.detail).toContain("output cap");
  });

  it("aborts the whole run on a missing toolchain or an unenforceable memory ceiling", () => {
    expect(interpretWorkerRun({ ...clean, code: EXIT.TOOL_MISSING }, "probe")).toEqual({
      abort: "toolMissing"
    });
    expect(
      interpretWorkerRun({ ...clean, code: EXIT.MEMORY_CEILING_UNSUPPORTED }, "range")
    ).toEqual({ abort: "memoryCeilingUnsupported" });
  });

  it("maps the worker's self-classified exit codes to rubric observations by stage", () => {
    expect(interpretWorkerRun({ ...clean, code: EXIT.PASSWORD_REQUIRED }, "probe").observation).toEqual(
      { kind: "password_required" }
    );
    expect(interpretWorkerRun({ ...clean, code: EXIT.MEMORY }, "range").observation).toEqual({
      kind: "memory"
    });
    // The shared conversion-failed exit is corruption at probe stage (excluded), a real conversion
    // failure at range stage (counted).
    expect(interpretWorkerRun({ ...clean, code: EXIT.CONVERSION_FAILED }, "probe").observation).toEqual(
      { kind: "corrupt" }
    );
    expect(interpretWorkerRun({ ...clean, code: EXIT.CONVERSION_FAILED }, "range").observation.kind).toBe(
      "conversion_failed"
    );
  });

  // #832: the worker's status gate has its own exit code, so a truncated run must be NAMED rather than
  // degrading to the generic `worker exit ${code}` fallback that every unmapped code lands in.
  it("names the worker's incomplete-conversion exit instead of the generic fallback", () => {
    const observation = interpretWorkerRun(
      { ...clean, code: EXIT.CONVERSION_INCOMPLETE },
      "range"
    ).observation;
    // The gate refuses before a payload exists and reports the failed pages on stderr, so no page count
    // travels with the refusal — and completeness is never inferred from what pages produced (D8).
    expect(observation).toEqual({ kind: "incomplete_conversion" });
    expect(observation.detail).toBeUndefined();
  });
});

// Regression for #787: the gate-producing worker timeout must be the SAME bound the live import lane
// enforces (serverConfig's 600000 ms), NOT the old 15-minute harness default. A PDF that only completes
// after production would have killed it (between 600000 ms and 15 minutes) must be classified `timed-out`
// and count against the 95% gate, never counted as a usable/gate-passing conversion. (#789 raised the
// shared bound from 180000 ms so a slower OCR-derived scanned page is not killed mid-conversion; the
// harness-vs-production equivalence this guards is unchanged — only the single owner's number moved.)
describe("worker timeout matches the production import lane, not a 15-minute harness default", () => {
  const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

  function fakeChild() {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    return child;
  }

  const fakeIo = (child) => ({
    spawn: () => child,
    createSampler: () => ({ stop: async () => null })
  });

  it("resolves the gate timeout from the shared server-config owner (600000 ms), well under 15 minutes", () => {
    // The harness no longer owns a timeout default: it consumes the single production owner, so omitting
    // --timeout-ms / PDF_TIMEOUT_MS yields exactly the 600000 ms bound the server kills a slow spawn at.
    expect(DEFAULT_PDF_TIMEOUT_MS).toBe(600_000);
    expect(resolveStructuredPdfTimeoutMs(undefined)).toBe(600_000);
    expect(DEFAULT_PDF_TIMEOUT_MS).toBeLessThan(FIFTEEN_MINUTES_MS);
  });

  it("kills a worker that finishes after the production bound but before 15 minutes, so it never counts as a gate success", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      const productionTimeoutMs = resolveStructuredPdfTimeoutMs(undefined);
      const pending = runWorker(
        "python",
        ["--range", "x", "1", "1"],
        productionTimeoutMs,
        2048,
        fakeIo(child)
      );

      // The worker would have completed only later (still before the old 15-minute default), but production
      // kills it at 600000 ms. Advancing just past the production bound fires the timeout and kills the child.
      await vi.advanceTimersByTimeAsync(productionTimeoutMs + 1);
      expect(child.killed).toBe(true);
      child.emit("close", null); // killed by signal -> null exit code

      const run = await pending;
      expect(run.timedOut).toBe(true);
      // A timeout is classified against the 95% gate as `timeout`, never parsed as a usable conversion.
      expect(interpretWorkerRun(run, "range").observation.kind).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("proves the old 15-minute default would NOT have fired at the same point (fail-before guard)", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild();
      // The pre-fix harness default. At 600001 ms — the exact point production kills — this timer is still
      // pending, so the same slow worker would run to a clean close and be wrongly counted as usable.
      const pending = runWorker(
        "python",
        ["--range", "x", "1", "1"],
        FIFTEEN_MINUTES_MS,
        2048,
        fakeIo(child)
      );

      await vi.advanceTimersByTimeAsync(resolveStructuredPdfTimeoutMs(undefined) + 1);
      expect(child.killed).toBe(false);
      child.emit("close", 0); // completes cleanly under the buggy default — a false gate success

      const run = await pending;
      expect(run.timedOut).toBe(false);
      expect(interpretWorkerRun(run, "range")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a non-positive or non-integer timeout override, so the worker never runs with a broken bound", () => {
    expect(() => resolveStructuredPdfTimeoutMs("0")).toThrow(
      "PDF_TIMEOUT_MS must be a positive integer number of milliseconds."
    );
    expect(() => resolveStructuredPdfTimeoutMs("not-a-number")).toThrow(
      "PDF_TIMEOUT_MS must be a positive integer number of milliseconds."
    );
    // An explicit positive override is honoured (used only for unmistakably non-gating diagnostic runs).
    expect(resolveStructuredPdfTimeoutMs("240000")).toBe(240_000);
  });
});
