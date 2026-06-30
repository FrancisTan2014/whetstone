import { desc, eq } from "drizzle-orm";

import { addressableBlocks } from "../../db/addressableBlocks.js";
import type { DbClient } from "../../db/dbClient.js";
import { noteAnchors, notes, workMeta } from "../../db/schema.js";

// One recent reading capture, shaped as a launchable harvest case (#243): the note that produced it,
// the prospective harvest case/chunk ids (the SAME ids `harvestReadingCase` creates, so a nudge and a
// practice lead refer to the same case), the captured snapshot, its source block, the work it came
// from, and when it was captured (the recency signal).
export type RecentReadingCapture = Readonly<{
  blockEntryId: string;
  caseId: string;
  capturedAt: Date;
  chunkId: string;
  noteEntryId: string;
  text: string;
  workTitle: string;
}>;

// The harvest case id for a captured note. Kept here (and reused by `harvestReadingCase`) so the
// nudge, the dismiss cooldown, and the practice lead all key off the same deterministic id.
export function harvestCaseId(noteEntryId: string): string {
  return `harvest-${noteEntryId}`;
}

export function harvestChunkId(noteEntryId: string): string {
  return `harvest-chunk-${noteEntryId}`;
}

// The user's most recent reading captures (a note + its selected-text anchor), newest first, capped at
// `limit`. Joined to the source block's work for the display title; the work join is LEFT so a capture
// whose block has no resolvable work still ranks (its title falls back to empty — real captures always
// resolve to a work). Note ids are uuids, so recency comes from `notes.created_at`, not id order.
export async function listRecentReadingCaptures(
  db: DbClient,
  userId: string,
  limit: number
): Promise<ReadonlyArray<RecentReadingCapture>> {
  const addressable = addressableBlocks(db);
  const rows = await db
    .select({
      blockEntryId: noteAnchors.blockEntryId,
      capturedAt: notes.createdAt,
      noteEntryId: notes.entryId,
      text: noteAnchors.selectedText,
      workTitle: workMeta.title
    })
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .leftJoin(addressable, eq(addressable.entryId, noteAnchors.blockEntryId))
    .leftJoin(workMeta, eq(workMeta.entryId, addressable.workEntryId))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.createdAt), desc(notes.entryId))
    .limit(limit);

  return rows.map((row) => ({
    blockEntryId: row.blockEntryId,
    caseId: harvestCaseId(row.noteEntryId),
    capturedAt: row.capturedAt,
    chunkId: harvestChunkId(row.noteEntryId),
    noteEntryId: row.noteEntryId,
    text: row.text,
    workTitle: row.workTitle ?? ""
  }));
}
