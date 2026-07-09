import type { TimelineCaptureDto } from "@whetstone/contracts";
import { and, asc, desc, eq, ne, notExists } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { makeDurableBackfillScans, proposalCandidates, timelineEntries } from "../../db/schema.js";

// One persisted timeline-entry row, as selected from the table.
export type TimelineEntryRow = typeof timelineEntries.$inferSelect;

export function toTimelineCaptureDto(row: TimelineEntryRow): TimelineCaptureDto {
  return {
    entryId: row.entryId,
    createdAt: row.createdAt.toISOString(),
    entryDate: row.entryDate,
    inputMode: row.inputMode,
    captureSource: row.captureSource,
    rawInputText: row.rawInputText,
    tidiedText: row.tidiedText,
    language: row.language,
    rawAudioPath: row.rawAudioPath
  };
}

// One capture scoped to its owner — used to authorize access against a forged id or another user's
// capture. Returns undefined when the id is unknown or owned by someone else.
export async function getTimelineCaptureForUser(
  db: DbClient,
  entryId: string,
  userId: string
): Promise<TimelineCaptureDto | undefined> {
  const rows = await db
    .select()
    .from(timelineEntries)
    .where(and(eq(timelineEntries.entryId, entryId), eq(timelineEntries.userId, userId)))
    .limit(1);

  return rows[0] === undefined ? undefined : toTimelineCaptureDto(rows[0]);
}

// The user's captures, newest first (created_at desc, entry id as a stable tiebreak).
export async function listTimelineCapturesForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<TimelineCaptureDto>> {
  const rows = await db
    .select()
    .from(timelineEntries)
    .where(eq(timelineEntries.userId, userId))
    .orderBy(desc(timelineEntries.createdAt), asc(timelineEntries.entryId));

  return rows.map(toTimelineCaptureDto);
}

// The user's Timeline captures that are eligible for a Make Durable backfill scan (#456): entries that
// have NO proposal candidate (a candidate — visible, pending, saved, OR dismissed — means the model
// already evaluated that entry under the identical gate) AND no backfill-scan marker (a prior run
// evaluated it and the model returned nothing). Diary-sourced captures are excluded (#559): the Diary is
// a filtered view over the same store, but Make Durable never mines diary entries in this task (that is
// a later capture-consolidation step), so its output is unchanged by diary rows landing in the store.
// Together these advance a durable cursor so a bounded run never re-scans entries already judged, and a
// high-value entry beyond one run's limit stays reachable. Oldest first, capped at `limit` per run.
export async function listBackfillableCaptures(
  db: DbClient,
  userId: string,
  limit: number
): Promise<ReadonlyArray<TimelineCaptureDto>> {
  const rows = await db
    .select()
    .from(timelineEntries)
    .where(
      and(
        eq(timelineEntries.userId, userId),
        ne(timelineEntries.captureSource, "diary"),
        notExists(
          db
            .select({ present: proposalCandidates.id })
            .from(proposalCandidates)
            .where(
              and(
                eq(proposalCandidates.timelineEntryId, timelineEntries.entryId),
                eq(proposalCandidates.userId, userId)
              )
            )
        ),
        notExists(
          db
            .select({ present: makeDurableBackfillScans.timelineEntryId })
            .from(makeDurableBackfillScans)
            .where(
              and(
                eq(makeDurableBackfillScans.timelineEntryId, timelineEntries.entryId),
                eq(makeDurableBackfillScans.userId, userId)
              )
            )
        )
      )
    )
    .orderBy(asc(timelineEntries.createdAt), asc(timelineEntries.entryId))
    .limit(limit);

  return rows.map(toTimelineCaptureDto);
}

// Record that a backfill run evaluated a Timeline entry and the model returned no proposal, so the
// bounded scan advances past it on later runs (see `listBackfillableCaptures`). Idempotent per entry: a
// re-scan cannot happen because the marker itself makes the entry ineligible.
export async function recordBackfillScan(
  db: DbClient,
  entryId: string,
  userId: string,
  now: Date
): Promise<void> {
  await db
    .insert(makeDurableBackfillScans)
    .values({ timelineEntryId: entryId, userId, scannedAt: now });
}
