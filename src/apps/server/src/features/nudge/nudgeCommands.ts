import type { NudgeDto } from "@whetstone/contracts";
import {
  chunkMasteryStatus,
  topReadingNudge,
  type ReadingNudgeCandidate,
  type ReviewState
} from "@whetstone/domain";
import { and, eq, gt, inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { nudgeState, recallItems } from "../../db/schema.js";
import { rowToReviewState } from "../recall/recallQueries.js";
import { listRecentReadingCaptures, type RecentReadingCapture } from "./nudgeQueries.js";

// How many recent captures the ranking considers. The nudge surfaces only the single top one, but a
// small window lets a fresher/higher-value capture win over the strict newest, and lets the next-best
// surface once the top is dismissed or practised.
const RECENT_CAPTURE_LIMIT = 10;

// Reading captures are not domain-frequency-weighted (they come from the learner's own reading, not the
// authored corpus), so every capture carries the same neutral weight and the value ranking reduces to
// gap + recency. A brand-new (unpractised) capture therefore has gap 1, so it stays rankable by recency.
const READING_NUDGE_FREQUENCY = 1;

// How long a dismiss suppresses a chunk: a few days, so a "not now" is honoured without the capture
// being lost forever — it can surface again once the cooldown lapses (gentle, never spammy).
const NUDGE_COOLDOWN_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Group the user's recall review states by the chunk each item links to, for the chunks under
// consideration. A chunk with no linked item (a never-practised capture) is simply absent (→ "new").
async function reviewStatesForChunkIds(
  db: DbClient,
  userId: string,
  chunkIds: ReadonlyArray<string>
): Promise<Map<string, ReviewState[]>> {
  const byChunk = new Map<string, ReviewState[]>();
  if (chunkIds.length === 0) {
    return byChunk;
  }

  const rows = await db
    .select()
    .from(recallItems)
    .where(and(eq(recallItems.userId, userId), inArray(recallItems.chunkId, [...chunkIds])));

  for (const row of rows) {
    // `chunkId` is non-null here: the `inArray` filter only matches linked items.
    const chunkId = row.chunkId as string;
    const states = byChunk.get(chunkId) ?? [];
    states.push(rowToReviewState(row));
    byChunk.set(chunkId, states);
  }

  return byChunk;
}

// The subset of the given chunks that are in cooldown for the user (a dismiss whose horizon is still in
// the future). User-scoped, so one user's cooldown never suppresses another's nudge.
async function listCooledDownChunkIds(
  db: DbClient,
  userId: string,
  now: Date,
  chunkIds: ReadonlyArray<string>
): Promise<Set<string>> {
  if (chunkIds.length === 0) {
    return new Set<string>();
  }

  const rows = await db
    .select({ chunkId: nudgeState.chunkId })
    .from(nudgeState)
    .where(
      and(
        eq(nudgeState.userId, userId),
        inArray(nudgeState.chunkId, [...chunkIds]),
        gt(nudgeState.dismissedUntil, now)
      )
    );

  return new Set(rows.map((row) => row.chunkId));
}

// Select the single capture to propose: rank the user's recent captures by gap × frequency + recency
// (the pure domain ranking), after excluding any chunk in cooldown, and return the top — or undefined
// when there is nothing to surface (no captures, or all are cooled down). Shared by the nudge endpoint
// AND the practice lead, so both propose the SAME case.
export async function selectReadingNudgeCapture(
  db: DbClient,
  userId: string,
  now: Date
): Promise<RecentReadingCapture | undefined> {
  const captures = await listRecentReadingCaptures(db, userId, RECENT_CAPTURE_LIMIT);
  const cooled = await listCooledDownChunkIds(
    db,
    userId,
    now,
    captures.map((capture) => capture.chunkId)
  );
  const available = captures.filter((capture) => !cooled.has(capture.chunkId));
  const statesByChunkId = await reviewStatesForChunkIds(
    db,
    userId,
    available.map((capture) => capture.chunkId)
  );

  const candidates: ReadingNudgeCandidate[] = available.map((capture) => ({
    blockEntryId: capture.blockEntryId,
    caseId: capture.caseId,
    capturedAt: capture.capturedAt,
    chunkId: capture.chunkId,
    frequency: READING_NUDGE_FREQUENCY,
    status: chunkMasteryStatus(statesByChunkId.get(capture.chunkId) ?? [], now),
    text: capture.text,
    workTitle: capture.workTitle
  }));

  const top = topReadingNudge(candidates, now);
  if (top === undefined) {
    return undefined;
  }

  const byChunkId = new Map(available.map((capture) => [capture.chunkId, capture]));
  return byChunkId.get(top.chunkId);
}

// Mark a chunk as surfaced now (lightweight interaction state), preserving any existing cooldown.
async function markSurfaced(
  db: DbClient,
  userId: string,
  chunkId: string,
  now: Date
): Promise<void> {
  await db
    .insert(nudgeState)
    .values({ chunkId, dismissedUntil: null, lastSurfacedAt: now, userId })
    .onConflictDoUpdate({
      set: { lastSurfacedAt: now },
      target: [nudgeState.userId, nudgeState.chunkId]
    });
}

// Compute the user's current nudge: the top-ranked, non-cooled-down recent capture as a `NudgeDto`, or
// null when there is nothing to surface. Surfacing records `last_surfaced_at`.
export async function computeReadingNudge(
  db: DbClient,
  userId: string,
  now: Date
): Promise<NudgeDto | null> {
  const capture = await selectReadingNudgeCapture(db, userId, now);
  if (capture === undefined) {
    return null;
  }

  await markSurfaced(db, userId, capture.chunkId, now);

  return {
    blockEntryId: capture.blockEntryId,
    caseId: capture.caseId,
    chunkId: capture.chunkId,
    text: capture.text,
    workTitle: capture.workTitle
  };
}

// Dismiss a chunk's nudge: set its cooldown horizon to `now + NUDGE_COOLDOWN_DAYS`, so it is suppressed
// for that window and can surface again afterwards. User-scoped; idempotent (upsert on the PK).
export async function dismissReadingNudge(
  db: DbClient,
  userId: string,
  chunkId: string,
  now: Date
): Promise<void> {
  const dismissedUntil = new Date(now.getTime() + NUDGE_COOLDOWN_DAYS * MS_PER_DAY);
  await db
    .insert(nudgeState)
    .values({ chunkId, dismissedUntil, lastSurfacedAt: null, userId })
    .onConflictDoUpdate({
      set: { dismissedUntil },
      target: [nudgeState.userId, nudgeState.chunkId]
    });
}
