import { proposalPayloadSchema, type MakeDurableCardDto } from "@whetstone/contracts";
import { and, asc, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { proposalCandidates } from "../../db/schema.js";
import type { ProposalCandidateRow } from "./proposalQueries.js";

// Today stays calm, never an inbox: at most this many pending Make Durable cards are surfaced at once
// (newest first). Extra visible candidates simply wait until the shown one is resolved.
export const MAKE_DURABLE_TODAY_CARD_CAP = 1;

// Build a Today review card from a visible candidate row: the ids/type/reason come from the row, the
// target/cue/use-context/category/tags from its stored (schema-validated) payload. `tags` is normalized
// to an array (never null) for the client.
export function toMakeDurableCard(row: ProposalCandidateRow): MakeDurableCardDto {
  const payload = proposalPayloadSchema.parse(row.payloadJson);
  return {
    proposalCandidateId: row.id,
    timelineEntryId: row.timelineEntryId,
    type: row.type,
    target: payload.target,
    cue: payload.cue,
    useContext: payload.useContext,
    reason: row.reason,
    category: payload.category,
    tags: payload.tags ?? []
  };
}

// The user's pending Make Durable cards for Today: visible candidates only, newest first, capped.
export async function listPendingCards(
  db: DbClient,
  userId: string,
  cap: number = MAKE_DURABLE_TODAY_CARD_CAP
): Promise<ReadonlyArray<MakeDurableCardDto>> {
  const rows = await db
    .select()
    .from(proposalCandidates)
    .where(and(eq(proposalCandidates.userId, userId), eq(proposalCandidates.status, "visible")))
    .orderBy(desc(proposalCandidates.createdAt), asc(proposalCandidates.id))
    .limit(cap);

  return rows.map(toMakeDurableCard);
}
