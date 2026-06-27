import { describe, expect, it } from "vitest";

import {
  chunkGap,
  deriveLevel,
  rankChunksByGapFrequency,
  type ChunkCandidate
} from "./learnerModel.js";

describe("chunkGap", () => {
  it.each([
    ["new", 1],
    ["due", 0.6],
    ["learning", 0.4],
    ["mastered", 0]
  ] as const)("maps %s to gap %d", (status, gap) => {
    expect(chunkGap(status)).toBe(gap);
  });
});

describe("deriveLevel", () => {
  it.each([
    [0, "beginner"],
    [0.19, "beginner"],
    [0.2, "elementary"],
    [0.39, "elementary"],
    [0.4, "intermediate"],
    [0.69, "intermediate"],
    [0.7, "advanced"],
    [1, "advanced"]
  ] as const)("maps mastered fraction %d to %s", (fraction, level) => {
    expect(deriveLevel(fraction)).toBe(level);
  });
});

describe("rankChunksByGapFrequency", () => {
  const candidate = (
    chunkId: string,
    frequency: number,
    status: ChunkCandidate["status"]
  ): ChunkCandidate => ({
    caseId: `${chunkId}-case`,
    chunkId,
    domainId: `${chunkId}-domain`,
    frequency,
    status
  });

  it("orders by gap x frequency descending and computes gap + score", () => {
    const ranked = rankChunksByGapFrequency(
      [
        candidate("low", 0.9, "mastered"), // gap 0 -> score 0
        candidate("high", 0.9, "new"), // gap 1 -> score 0.9
        candidate("mid", 0.5, "new") // gap 1 -> score 0.5
      ],
      10
    );

    expect(ranked.map((entry) => entry.chunkId)).toEqual(["high", "mid", "low"]);
    expect(ranked[0]).toMatchObject({ gap: 1, score: 0.9 });
    expect(ranked[2]).toMatchObject({ gap: 0, score: 0 });
  });

  it("breaks score ties by chunk id ascending", () => {
    const ranked = rankChunksByGapFrequency(
      [candidate("b", 0.5, "new"), candidate("a", 0.5, "new")],
      10
    );
    expect(ranked.map((entry) => entry.chunkId)).toEqual(["a", "b"]);
  });

  it("keeps only the top `limit`", () => {
    const ranked = rankChunksByGapFrequency(
      [candidate("a", 0.9, "new"), candidate("b", 0.5, "new"), candidate("c", 0.1, "new")],
      2
    );
    expect(ranked.map((entry) => entry.chunkId)).toEqual(["a", "b"]);
  });
});
