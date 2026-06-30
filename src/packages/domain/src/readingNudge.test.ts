import { describe, expect, it } from "vitest";

import type { ChunkMasteryStatus } from "./caseMastery.js";
import {
  rankReadingNudges,
  recencyBoost,
  topReadingNudge,
  type ReadingNudgeCandidate
} from "./readingNudge.js";

const now = new Date("2026-03-01T00:00:00.000Z");
const day = 24 * 60 * 60 * 1000;
const ago = (days: number): Date => new Date(now.getTime() - days * day);

function candidate(
  chunkId: string,
  status: ChunkMasteryStatus,
  capturedAt: Date,
  overrides: Partial<ReadingNudgeCandidate> = {}
): ReadingNudgeCandidate {
  return {
    blockEntryId: `${chunkId}-block`,
    caseId: `${chunkId}-case`,
    capturedAt,
    chunkId,
    frequency: 1,
    status,
    text: `text-${chunkId}`,
    workTitle: `Work ${chunkId}`,
    ...overrides
  };
}

describe("recencyBoost", () => {
  it("peaks for a just-captured snippet and halves every half-life", () => {
    expect(recencyBoost(now, now)).toBeCloseTo(0.5, 10);
    expect(recencyBoost(now, ago(7))).toBeCloseTo(0.25, 10);
    expect(recencyBoost(now, ago(14))).toBeCloseTo(0.125, 10);
  });

  it("floors a future-dated capture's age at zero (no amplification on clock skew)", () => {
    const future = new Date(now.getTime() + 5 * day);
    expect(recencyBoost(now, future)).toBeCloseTo(0.5, 10);
  });
});

describe("rankReadingNudges", () => {
  it("leads with the highest gap x frequency even when a lower-value capture is fresher", () => {
    const ranked = rankReadingNudges(
      [
        candidate("fresh-low", "learning", now), // gap 0.4 + 0.5 = 0.9
        candidate("stale-high", "new", ago(14)) // gap 1 + 0.125 = 1.125
      ],
      now
    );

    expect(ranked.map((entry) => entry.chunkId)).toEqual(["stale-high", "fresh-low"]);
    expect(ranked[0]?.score).toBeCloseTo(1.125, 10);
  });

  it("breaks an equal gap x frequency by recency — the fresher capture wins", () => {
    const ranked = rankReadingNudges(
      [candidate("older", "new", ago(10)), candidate("newer", "new", now)],
      now
    );

    expect(ranked.map((entry) => entry.chunkId)).toEqual(["newer", "older"]);
  });

  it("lets recency lift a fresher, slightly-lower-gap capture over a stale higher-gap one", () => {
    const ranked = rankReadingNudges(
      [
        candidate("fresh-due", "due", now), // gap 0.6 + 0.5 = 1.1
        candidate("stale-new", "new", ago(21)) // gap 1 + ~0.0625 = ~1.0625
      ],
      now
    );

    expect(ranked[0]?.chunkId).toBe("fresh-due");
  });

  it("weights gap by the domain frequency", () => {
    const ranked = rankReadingNudges(
      [
        candidate("weak-rare", "new", now, { frequency: 0.2 }), // 0.2 + 0.5 = 0.7
        candidate("weak-common", "new", now, { frequency: 1 }) // 1 + 0.5 = 1.5
      ],
      now
    );

    expect(ranked[0]?.chunkId).toBe("weak-common");
  });

  it("breaks an exact score tie by chunk id ascending", () => {
    const ranked = rankReadingNudges([candidate("b", "new", now), candidate("a", "new", now)], now);

    expect(ranked.map((entry) => entry.chunkId)).toEqual(["a", "b"]);
  });
});

describe("topReadingNudge", () => {
  it("returns the single highest-ranked capture", () => {
    const top = topReadingNudge(
      [candidate("low", "mastered", now), candidate("high", "new", now)],
      now
    );

    expect(top?.chunkId).toBe("high");
  });

  it("returns undefined when there are no candidates", () => {
    expect(topReadingNudge([], now)).toBeUndefined();
  });
});
