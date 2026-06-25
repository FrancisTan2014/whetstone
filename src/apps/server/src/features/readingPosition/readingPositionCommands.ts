import type { UpsertReadingPositionRequest } from "@whetstone/contracts";
import type { EntryId } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { readingPositions } from "../../db/schema.js";

// The database client is injected so the command stays deterministic and testable.
export type ReadingPositionDependencies = Readonly<{ db: DbClient }>;

// Save (insert or replace) the reader's position for one (user, work): the last open unit and an
// optional block anchor (null when absent = top of the unit), stamped with the current time. The
// composite (userId, workEntryId) key means each user keeps exactly one row per work, so re-saving
// updates in place rather than accumulating history.
export async function upsertReadingPosition(
  dependencies: ReadingPositionDependencies,
  workEntryId: EntryId,
  userId: string,
  request: UpsertReadingPositionRequest
): Promise<void> {
  const anchorBlockEntryId = request.anchorBlockEntryId ?? null;
  const updatedAt = new Date();

  await dependencies.db
    .insert(readingPositions)
    .values({
      anchorBlockEntryId,
      unitEntryId: request.unitEntryId,
      updatedAt,
      userId,
      workEntryId
    })
    .onConflictDoUpdate({
      set: { anchorBlockEntryId, unitEntryId: request.unitEntryId, updatedAt },
      target: [readingPositions.userId, readingPositions.workEntryId]
    });
}
