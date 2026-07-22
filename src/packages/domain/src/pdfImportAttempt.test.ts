import { describe, expect, it } from "vitest";

import {
  isNonTerminalAttemptState,
  isRetryableAttemptState,
  mayApplyRunOutput,
  nextRangeIndex,
  pdfImportAttemptStates,
  type PdfImportAttemptState
} from "./pdfImportAttempt.js";

describe("pdfImportAttemptStates", () => {
  it("lists the six lifecycle states", () => {
    expect(pdfImportAttemptStates).toEqual([
      "queued",
      "running",
      "converted",
      "failed",
      "cancelled",
      "interrupted"
    ]);
  });
});

describe("isNonTerminalAttemptState", () => {
  it("is true for queued, running, and interrupted (the cancellable set)", () => {
    for (const state of ["queued", "running", "interrupted"] as const) {
      expect(isNonTerminalAttemptState(state)).toBe(true);
    }
  });

  it("is false for the terminal states", () => {
    for (const state of ["converted", "failed", "cancelled"] as const) {
      expect(isNonTerminalAttemptState(state)).toBe(false);
    }
  });
});

describe("isRetryableAttemptState", () => {
  it("is true only for interrupted", () => {
    expect(isRetryableAttemptState("interrupted")).toBe(true);
  });

  it("is false for every other state", () => {
    for (const state of ["queued", "running", "converted", "failed", "cancelled"] as const) {
      expect(isRetryableAttemptState(state)).toBe(false);
    }
  });
});

describe("mayApplyRunOutput", () => {
  const token = "run-token-1";

  it("applies while running under the same run token", () => {
    expect(mayApplyRunOutput({ state: "running", runToken: token }, token)).toBe(true);
  });

  it("fences a mismatched run token", () => {
    expect(mayApplyRunOutput({ state: "running", runToken: "other" }, token)).toBe(false);
  });

  it("fences a null run token (no live claim)", () => {
    expect(mayApplyRunOutput({ state: "running", runToken: null }, token)).toBe(false);
  });

  it("fences a non-running attempt even with a matching token", () => {
    for (const state of [
      "queued",
      "converted",
      "failed",
      "cancelled",
      "interrupted"
    ] satisfies PdfImportAttemptState[]) {
      expect(mayApplyRunOutput({ state, runToken: token }, token)).toBe(false);
    }
  });
});

describe("nextRangeIndex", () => {
  it("resumes at 0 when nothing is committed", () => {
    expect(nextRangeIndex([], 4)).toBe(0);
  });

  it("resumes after a contiguous committed prefix", () => {
    expect(nextRangeIndex([0, 1], 4)).toBe(2);
  });

  it("resumes at the first gap, never past it", () => {
    expect(nextRangeIndex([0, 2], 3)).toBe(1);
  });

  it("returns totalRanges when every range is committed", () => {
    expect(nextRangeIndex([0, 1, 2], 3)).toBe(3);
  });
});
