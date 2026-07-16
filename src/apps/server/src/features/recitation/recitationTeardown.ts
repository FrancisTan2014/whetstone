import { inArray } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recitationReviewEvidence, reviewEvents } from "../../db/schema.js";
import { deleteReviewCardsAndEvents } from "../review/reviewCardCommands.js";

// The transaction handle drizzle passes into `db.transaction`, so this teardown composes inside a
// caller's transaction (a Work deletion cascading its recitation rows).
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Tear down ALL shared scheduling + Recitation-owned evidence for a set of recitation targets (the
// Work-level target, plus any LEGACY passage/whole-Work targets a Work still carries — #643 retires their
// scheduling but preserves their rows), inside the caller's transaction, referentially safe (#618): the
// cue-strength evidence keyed to each target's `rating` events is removed first (it FKs `review_events`),
// then the shared cards + events themselves. Used only when the targets' Work is being deleted, so no
// orphaned schedule, event, or evidence outlives it.
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
