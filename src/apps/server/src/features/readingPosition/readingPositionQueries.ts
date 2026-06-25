import type { EntryId } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { readingPositions } from "../../db/schema.js";

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
