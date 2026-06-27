// Pure learner-model logic (#208): the deterministic, storage-free pieces of "how the coach knows
// your progress" — the gap-times-frequency ranking the coach uses to light the next region
// (fog-of-war navigation), the proficiency-level derivation, and the canonical error taxonomy. No
// persistence, network, or LLM: the server feeds in signals it has queried, and these compute the
// ranking/level the same way for the real flow and the tests.

import type { ChunkMasteryStatus } from "./caseMastery.js";

// The categorized recurring-error taxonomy (article drop, L1 calque, wrong collocation, ...). Mirrored
// as a Zod enum in `@whetstone/contracts` (`learnerContracts.ts`); keep the two in sync.
export const errorCategories = [
  "article_drop",
  "l1_calque",
  "wrong_collocation",
  "register",
  "word_order",
  "tense_aspect",
  "other"
] as const;

export type ErrorCategory = (typeof errorCategories)[number];

// Coarse proficiency bands, lowest to highest. Mirrored in `@whetstone/contracts`.
export const proficiencyLevels = ["beginner", "elementary", "intermediate", "advanced"] as const;

export type ProficiencyLevel = (typeof proficiencyLevels)[number];

// How much of a chunk the learner still lacks, from its mastery status: a brand-new chunk is a full
// gap (1), a mastered one is none (0); a due (lapsing) chunk outranks one still being learned because
// it is slipping away.
const gapByStatus: Readonly<Record<ChunkMasteryStatus, number>> = Object.freeze({
  new: 1,
  due: 0.6,
  learning: 0.4,
  mastered: 0
});

export function chunkGap(status: ChunkMasteryStatus): number {
  return gapByStatus[status];
}

// Derive the proficiency band from the fraction of the corpus the learner has mastered. Thresholds are
// inclusive at the lower bound, so 0 is beginner and 1 is advanced.
export function deriveLevel(masteredFraction: number): ProficiencyLevel {
  if (masteredFraction < 0.2) {
    return "beginner";
  }
  if (masteredFraction < 0.4) {
    return "elementary";
  }
  if (masteredFraction < 0.7) {
    return "intermediate";
  }
  return "advanced";
}

// A candidate chunk to rank: its identity, the importance/frequency weight of its domain, and the
// learner's current mastery status for it.
export type ChunkCandidate = Readonly<{
  caseId: string;
  chunkId: string;
  domainId: string;
  frequency: number;
  status: ChunkMasteryStatus;
}>;

// A ranked candidate, carrying the derived gap and the gap-times-frequency score the order is by.
export type RankedChunk = Readonly<{
  caseId: string;
  chunkId: string;
  domainId: string;
  frequency: number;
  gap: number;
  score: number;
  status: ChunkMasteryStatus;
}>;

// Rank candidates by gap x frequency, highest first (chunk id breaks ties for a stable order), and
// keep the top `limit`. This is the navigation signal: high-value-in-real-life chunks the learner is
// weakest on come first; fully mastered chunks (gap 0) sink to the bottom.
export function rankChunksByGapFrequency(
  candidates: ReadonlyArray<ChunkCandidate>,
  limit: number
): ReadonlyArray<RankedChunk> {
  return candidates
    .map((candidate) => {
      const gap = chunkGap(candidate.status);
      return { ...candidate, gap, score: gap * candidate.frequency };
    })
    .sort((left, right) =>
      right.score === left.score
        ? left.chunkId.localeCompare(right.chunkId)
        : right.score - left.score
    )
    .slice(0, limit);
}
