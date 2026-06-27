import { describe, expect, it } from "vitest";

import { deriveSpeechTiming } from "./speechTiming.js";

describe("deriveSpeechTiming", () => {
  it("is all-zero for no words", () => {
    expect(deriveSpeechTiming([])).toEqual({
      interWordPauses: [],
      latencyMs: 0,
      totalDurationMs: 0
    });
  });

  it("reports latency and span but no pauses for a single word", () => {
    expect(deriveSpeechTiming([{ end: 800, start: 300 }])).toEqual({
      interWordPauses: [],
      latencyMs: 300,
      totalDurationMs: 500
    });
  });

  it("derives latency, inter-word pauses, and total span across words", () => {
    expect(
      deriveSpeechTiming([
        { end: 400, start: 0 },
        { end: 900, start: 600 },
        { end: 1500, start: 1000 }
      ])
    ).toEqual({
      interWordPauses: [200, 100],
      latencyMs: 0,
      totalDurationMs: 1500
    });
  });

  it("clamps an overlapping pair to a zero pause", () => {
    expect(
      deriveSpeechTiming([
        { end: 500, start: 0 },
        { end: 700, start: 400 }
      ]).interWordPauses
    ).toEqual([0]);
  });
});
