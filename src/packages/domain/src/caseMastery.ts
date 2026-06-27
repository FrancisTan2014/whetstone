// Pure derivation of a per-case mastery summary from #189 review state. Mastery is COMPUTED from the
// learner's recall items (never stored on the shared content): each chunk is classified from the
// review state(s) of the recall item(s) linked to it, and the case summary is the bucket counts.
// No persistence, network, or UI — time enters only via a passed-in `now`.

import type { ReviewState } from "./sm2.js";

// A chunk's mastery status for one learner:
// - "new": the learner has no recall item linked to the chunk yet.
// - "due": at least one linked item is due for review now (needs attention).
// - "learning": enrolled and not due, but not yet graduated.
// - "mastered": enrolled, not due, and every linked item has graduated.
export const chunkMasteryStatuses = ["new", "learning", "due", "mastered"] as const;

export type ChunkMasteryStatus = (typeof chunkMasteryStatuses)[number];

// A chunk is treated as graduated once it has been recalled successfully this many consecutive times
// (SM-2 resets `repetitions` to 0 on a lapse, so this is a streak of clean reviews).
const MASTERY_REPETITIONS = 3;

export type CaseMasterySummary = Readonly<{
  totalChunks: number;
  newChunks: number;
  learningChunks: number;
  dueChunks: number;
  masteredChunks: number;
}>;

function isDue(state: ReviewState, now: Date): boolean {
  return new Date(state.dueAt).getTime() <= now.getTime();
}

function isMastered(state: ReviewState): boolean {
  return state.repetitions >= MASTERY_REPETITIONS;
}

// Classify a single chunk from the review states of the recall items linked to it. "due" wins over
// "mastered": an item that has graduated but has come due again still needs reviewing.
export function chunkMasteryStatus(
  states: ReadonlyArray<ReviewState>,
  now: Date
): ChunkMasteryStatus {
  if (states.length === 0) {
    return "new";
  }

  if (states.some((state) => isDue(state, now))) {
    return "due";
  }

  if (states.every(isMastered)) {
    return "mastered";
  }

  return "learning";
}

// Summarise a case: classify each of its chunks and count the buckets. The bucket counts always sum
// to `totalChunks`. `statesByChunkId` maps a chunk id to the review states of that learner's recall
// items linked to it; a chunk absent from the map (or mapped to an empty list) counts as "new".
export function summarizeCaseMastery(
  chunkIds: ReadonlyArray<string>,
  statesByChunkId: ReadonlyMap<string, ReadonlyArray<ReviewState>>,
  now: Date
): CaseMasterySummary {
  let newChunks = 0;
  let learningChunks = 0;
  let dueChunks = 0;
  let masteredChunks = 0;

  for (const chunkId of chunkIds) {
    const status = chunkMasteryStatus(statesByChunkId.get(chunkId) ?? [], now);
    if (status === "new") {
      newChunks += 1;
    } else if (status === "due") {
      dueChunks += 1;
    } else if (status === "mastered") {
      masteredChunks += 1;
    } else {
      learningChunks += 1;
    }
  }

  return {
    totalChunks: chunkIds.length,
    newChunks,
    learningChunks,
    dueChunks,
    masteredChunks
  };
}
