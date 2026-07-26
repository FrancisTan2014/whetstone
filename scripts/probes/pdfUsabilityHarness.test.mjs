// Unit tests for the pure worker-run decisions the PDF usability harness relies on. The harness itself is
// coverage-excluded I/O orchestration (like scripts/probes/pdfStructuredCorpusProbe.mjs), but the
// OUTPUT-CAP INVARIANT it added must be falsifiable: an over-cap worker run has to be classified as a
// production failure, never parsed from truncated output and counted as usable. These tests pin (1) the
// bounded stdout accumulator's exact 64 MiB boundary, (2) runWorker killing the child and reporting
// `overCap` when the cap is exceeded, and (3) interpretWorkerRun mapping an over-cap run to an in-bound
// conversion failure that counts against the 95% gate.

import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

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
});
