import type { TimelineCaptureDto } from "@whetstone/contracts";
import { and, asc, desc, eq, notExists } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { proposalCandidates, timelineEntries } from "../../db/schema.js";

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

// The user's Timeline captures that are eligible for a Make Durable backfill scan (#456): entries with
// NO proposal candidate at all (a candidate — visible, pending, saved, OR dismissed — means the model
// already evaluated that entry under the identical gate, so it must not be re-mined). Oldest first, so a
// bounded scan works through the historical backlog deterministically, capped at `limit` per run.
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
        )
      )
    )
    .orderBy(asc(timelineEntries.createdAt), asc(timelineEntries.entryId))
    .limit(limit);

  return rows.map(toTimelineCaptureDto);
}
