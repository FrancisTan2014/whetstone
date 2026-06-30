import type { EntryId } from "@whetstone/domain";
import { and, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { readingPositions, workMeta } from "../../db/schema.js";

// The stored position for one (user, work): the last open unit and an optional block anchor
// (null = top of the unit). The web falls back via `resolveOpening` if the unit/anchor no longer
// exist, so this is a plain scoped read — it does not validate that they still resolve.
export type StoredReadingPosition = Readonly<{
  anchorBlockEntryId: string | null;
  unitEntryId: string;
}>;

export async function getReadingPosition(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<StoredReadingPosition | undefined> {
  const rows = await db
    .select({
      anchorBlockEntryId: readingPositions.anchorBlockEntryId,
      unitEntryId: readingPositions.unitEntryId
    })
    .from(readingPositions)
    .where(and(eq(readingPositions.userId, userId), eq(readingPositions.workEntryId, workEntryId)))
    .limit(1);

  return rows[0];
}

// The user's single most-recently-updated position across ALL works, joined to `work_meta` for the
// title — the seam the Today home's "Continue reading" card composes (the per-work read above is keyed
// to one work). Ordered by `updated_at` desc so the last save wins; `undefined` when the user has none.
export type LatestReadingPosition = Readonly<{
  anchorBlockEntryId: string | null;
  unitEntryId: string;
  workEntryId: string;
  workTitle: string;
}>;

export async function getLatestReadingPosition(
  db: DbClient,
  userId: string
): Promise<LatestReadingPosition | undefined> {
  const rows = await db
    .select({
      anchorBlockEntryId: readingPositions.anchorBlockEntryId,
      unitEntryId: readingPositions.unitEntryId,
      workEntryId: readingPositions.workEntryId,
      workTitle: workMeta.title
    })
    .from(readingPositions)
    .innerJoin(workMeta, eq(workMeta.entryId, readingPositions.workEntryId))
    .where(eq(readingPositions.userId, userId))
    .orderBy(desc(readingPositions.updatedAt))
    .limit(1);

  return rows[0];
}
