import type { RecitationCueStrengthDto } from "@whetstone/contracts";
import { RECITATION_REQUEST_RETENTION } from "@whetstone/domain";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { recitationPassages, recitationReviewEvidence, reviewCards } from "../../db/schema.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { type ReviewCardRow } from "../review/reviewCardQueries.js";
import { type RecitationPassageRow } from "./recitationPassageQueries.js";

// The transaction handle drizzle passes into `db.transaction`: the same query builder as `DbClient`, so a
// helper can run scoped writes inside an open transaction.
export type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Re-select a target's card within an open transaction (after a seed inside the same tx), so a rating can
// be applied to it without a separate connection. The caller only asks for a card it just ensured exists.
export async function selectCardInTx(
  tx: Transaction,
  targetEntryId: string
): Promise<ReviewCardRow | undefined> {
  const [row] = await tx
    .select()
    .from(reviewCards)
    .where(eq(reviewCards.targetEntryId, targetEntryId))
    .limit(1);
  return row;
}

// Activate a queued passage inside the transaction: stamp `introduced_at` and seed its shared review card
// at the recitation policy (#618), returning the seeded card. Used when a review (or lead-in failure)
// lands on a passage that has not yet been introduced — introduction is explicit and atomic with card
// creation, so a queued passage never has a card and an active passage always does.
export async function activatePassageInTx(
  tx: Transaction,
  passageEntryId: string,
  userId: string,
  now: Date
): Promise<ReviewCardRow> {
  await tx
    .update(recitationPassages)
    .set({ introducedAt: now })
    .where(eq(recitationPassages.entryId, passageEntryId));
  await seedReviewCard(tx, {
    targetEntryId: passageEntryId,
    userId,
    requestedRetention: RECITATION_REQUEST_RETENTION,
    now
  });
  // Just seeded in this tx, so the card is present.
  return (await selectCardInTx(tx, passageEntryId))!;
}

// Ensure a passage owns a card inside the transaction, activating it if still queued; then return it.
export async function ensurePassageCardInTx(
  tx: Transaction,
  row: RecitationPassageRow,
  userId: string,
  now: Date
): Promise<ReviewCardRow> {
  const existing = row.introducedAt === null ? undefined : await selectCardInTx(tx, row.entryId);
  return existing ?? (await activatePassageInTx(tx, row.entryId, userId, now));
}

// Attach a passage's cue-strength evidence to a shared review event (#618).
export async function writeCueStrengthEvidence(
  tx: Transaction,
  eventId: string,
  cueStrength: RecitationCueStrengthDto
): Promise<void> {
  await tx.insert(recitationReviewEvidence).values({ reviewEventId: eventId, cueStrength });
}
