import { inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recitationReviewEvidence, reviewEvents } from "../../db/schema.js";
import { deleteReviewCardsAndEvents } from "../review/reviewCardCommands.js";

// The transaction handle drizzle passes into `db.transaction`, so this teardown composes inside a
// caller's transaction (a passage split/merge, a plan/Work deletion).
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Tear down ALL shared scheduling + Recitation-owned evidence for a set of recitation targets (passage or
// whole-Work Entry ids), inside the caller's transaction, referentially safe (#618): the cue-strength
// evidence keyed to each target's `rating` events is removed first (it FKs `review_events`), then the
// shared cards + events themselves. Used when the targets are being deleted or reset, so no orphaned
// schedule, event, or evidence outlives them.
export async function deleteRecitationReviewData(
  tx: Transaction,
  targetEntryIds: ReadonlyArray<string>
): Promise<void> {
  const ids = [...targetEntryIds];
  const events = await tx
    .select({ id: reviewEvents.id })
    .from(reviewEvents)
    .where(inArray(reviewEvents.targetEntryId, ids));
  const eventIds = events.map((row) => row.id);
  if (eventIds.length > 0) {
    await tx
      .delete(recitationReviewEvidence)
      .where(inArray(recitationReviewEvidence.reviewEventId, eventIds));
  }
  await deleteReviewCardsAndEvents(tx, ids);
}
