import {
  chunkMasteryStatus,
  topReadingCapture,
  type ReadingCaptureCandidate
} from "@whetstone/domain";
import { asc } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { cases, chunks, domains } from "../../db/schema.js";
import { reviewStatesByChunkIds } from "../memory/memoryQueries.js";
import { listRecentReadingCaptures, type RecentReadingCapture } from "./harvestQueries.js";

// How many recent captures the ranking considers. The lead surfaces only the single top one, but a
// small window lets a fresher/higher-value capture win over the strict newest, and lets the next-best
// surface once the top has been practised.
const RECENT_CAPTURE_LIMIT = 10;

// Reading captures are not domain-frequency-weighted (they come from the learner's own reading, not the
// authored corpus), so every capture carries the same neutral weight and the value ranking reduces to
// gap + recency. A brand-new (unpractised) capture therefore has gap 1, so it stays rankable by recency.
const READING_CAPTURE_FREQUENCY = 1;

// Select the single capture to seed the harvest case: rank the user's recent captures by
// gap × frequency + recency (the pure domain ranking) and return the top — or undefined when there is
// nothing to surface (no captures). User-scoped, because the capture query filters by owner.
export async function selectReadingHarvestCapture(
  db: DbClient,
  userId: string,
  now: Date
): Promise<RecentReadingCapture | undefined> {
  const captures = await listRecentReadingCaptures(db, userId, RECENT_CAPTURE_LIMIT);
  const statesByChunkId = await reviewStatesByChunkIds(
    db,
    userId,
    captures.map((capture) => capture.chunkId)
  );

  const candidates: ReadingCaptureCandidate[] = captures.map((capture) => ({
    blockEntryId: capture.blockEntryId,
    caseId: capture.caseId,
    capturedAt: capture.capturedAt,
    chunkId: capture.chunkId,
    frequency: READING_CAPTURE_FREQUENCY,
    status: chunkMasteryStatus(statesByChunkId.get(capture.chunkId) ?? [], now),
    text: capture.text,
    workTitle: capture.workTitle
  }));

  const top = topReadingCapture(candidates, now);
  if (top === undefined) {
    return undefined;
  }

  const byChunkId = new Map(captures.map((capture) => [capture.chunkId, capture]));
  return byChunkId.get(top.chunkId);
}

// The reading -> speaking on-ramp (#243): the differentiator is that practice grows from what the user
// just read. A recent reading capture (a note with a selected-text anchor) seeds a case whose target
// chunk IS that text, linked to the source block, so production recycles their reading. The capture is
// chosen by the value ranking (gap × frequency + recency) — the top-ranked capture, not merely the
// newest — so the Practice entry leads with the proposed case. Seeding is idempotent (keyed off the
// note), and returns null when there is no eligible capture (fall back to authored), or when there are
// no domains to attach a harvested case to.
export type HarvestedCue = Readonly<{
  caseId: string;
  chunkId: string;
  communicativeFunction: string;
  situation: string;
  target: string;
}>;

export async function harvestReadingCase(
  db: DbClient,
  userId: string,
  now: Date
): Promise<HarvestedCue | null> {
  const capture = await selectReadingHarvestCapture(db, userId, now);
  if (capture === undefined) {
    return null;
  }

  const domainRows = await db
    .select({ id: domains.id })
    .from(domains)
    .orderBy(asc(domains.orderIndex))
    .limit(1);
  const domainId = domainRows[0]?.id;
  if (domainId === undefined) {
    return null;
  }

  const { caseId, chunkId } = capture;
  const situation = "Use what you just read in a quick exchange.";
  const communicativeFunction = "Recycle a phrase from your reading";

  await db
    .insert(cases)
    .values({
      briefKey: caseId,
      communicativeFunction,
      domainId,
      id: caseId,
      orderIndex: 0,
      situation
    })
    .onConflictDoNothing();
  await db
    .insert(chunks)
    .values({
      caseId,
      id: chunkId,
      orderIndex: 0,
      sourceBlockEntryId: capture.blockEntryId,
      text: capture.text
    })
    .onConflictDoNothing();

  return { caseId, chunkId, communicativeFunction, situation, target: capture.text };
}
