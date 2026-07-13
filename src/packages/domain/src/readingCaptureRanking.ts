// Pure ranking for the reading→speaking harvest on-ramp (#243): a recent reading capture is chosen to
// seed a practice case. The order is gap × frequency (the same value signal the coach navigates by)
// PLUS a bounded recency term, so a fresher capture is gently lifted but never overwhelms a
// higher-value one. No persistence, network, or UI: the server feeds in candidates it has queried,
// and these compute the ranking the harvest lead selects by. (The retired reading→Practice nudge, #245,
// once shared this ranking; it now serves the harvest on-ramp alone.)

import { chunkGap } from "./learnerModel.js";
import type { ChunkMasteryStatus } from "./caseMastery.js";

// The recency term peaks for a just-captured snippet and halves every RECENCY_HALF_LIFE_DAYS, so it
// decays toward zero as a capture ages. Peak is deliberately below a full gap unit (chunkGap("new")
// is 1), so gap × frequency dominates between captures of similar age while recency breaks ties and
// can lift a fresher, slightly-lower-gap capture over a stale higher-gap one.
const RECENCY_PEAK = 0.5;
const RECENCY_HALF_LIFE_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// A bounded, exponentially-decaying boost in (0, RECENCY_PEAK]. Age is floored at 0 so a capture
// dated in the future (clock skew) is treated as brand new rather than amplified.
export function recencyBoost(now: Date, capturedAt: Date): number {
  const ageDays = Math.max(0, (now.getTime() - capturedAt.getTime()) / MS_PER_DAY);
  return RECENCY_PEAK * Math.pow(2, -ageDays / RECENCY_HALF_LIFE_DAYS);
}

// A reading capture eligible to seed the harvest case: its identity and display text, the source block
// it was captured from (for provenance / deep-linking), when it was captured (recency), and the value
// signals (its domain frequency weight and the learner's current mastery status for the chunk).
export type ReadingCaptureCandidate = Readonly<{
  blockEntryId?: string;
  caseId: string;
  capturedAt: Date;
  chunkId: string;
  frequency: number;
  status: ChunkMasteryStatus;
  text: string;
  workTitle: string;
}>;

// A ranked candidate, carrying the gap × frequency + recency score the order is by.
export type RankedReadingCapture = ReadingCaptureCandidate & Readonly<{ score: number }>;

// Rank captures by gap × frequency + recency, highest first (chunk id breaks exact ties for a stable
// order). The freshest, highest-value capture the learner is weakest on comes first.
export function rankReadingCaptures(
  candidates: ReadonlyArray<ReadingCaptureCandidate>,
  now: Date
): ReadonlyArray<RankedReadingCapture> {
  return candidates
    .map((candidate) => ({
      ...candidate,
      score:
        chunkGap(candidate.status) * candidate.frequency + recencyBoost(now, candidate.capturedAt)
    }))
    .sort((left, right) =>
      right.score === left.score
        ? left.chunkId.localeCompare(right.chunkId)
        : right.score - left.score
    );
}

// The single highest-ranked capture, or undefined when there are none to surface.
export function topReadingCapture(
  candidates: ReadonlyArray<ReadingCaptureCandidate>,
  now: Date
): RankedReadingCapture | undefined {
  return rankReadingCaptures(candidates, now)[0];
}
