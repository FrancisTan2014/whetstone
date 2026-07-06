import type { JsonObject, ProposalCandidateDto, ProposalReviewDto } from "@whetstone/contracts";
import { and, asc, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { proposalCandidates, proposalReviews } from "../../db/schema.js";

export type ProposalCandidateRow = typeof proposalCandidates.$inferSelect;
export type ProposalReviewRow = typeof proposalReviews.$inferSelect;

export function toProposalCandidateDto(row: ProposalCandidateRow): ProposalCandidateDto {
  return {
    id: row.id,
    timelineEntryId: row.timelineEntryId,
    type: row.type,
    status: row.status,
    confidence: row.confidence,
    reason: row.reason,
    evidenceQuote: row.evidenceQuote,
    payload: row.payloadJson as JsonObject,
    duplicateStatus: row.duplicateStatus,
    relatedRecallItemId: row.relatedRecallItemId,
    noveltyReason: row.noveltyReason,
    modelName: row.modelName,
    promptVersion: row.promptVersion,
    createdAt: row.createdAt.toISOString()
  };
}

export function toProposalReviewDto(row: ProposalReviewRow): ProposalReviewDto {
  return {
    id: row.id,
    proposalCandidateId: row.proposalCandidateId,
    outcome: row.outcome,
    feedbackTags: row.feedbackTagsJson ?? null,
    editedPayload: (row.editedPayloadJson ?? null) as JsonObject | null,
    createdAt: row.createdAt.toISOString()
  };
}

// One candidate scoped to its owner — used to authorize a review against a forged id or another user's
// candidate. Returns the raw row so the caller can both authorize and read it.
export async function getProposalCandidateRowForUser(
  db: DbClient,
  id: string,
  userId: string
): Promise<ProposalCandidateRow | undefined> {
  const rows = await db
    .select()
    .from(proposalCandidates)
    .where(and(eq(proposalCandidates.id, id), eq(proposalCandidates.userId, userId)))
    .limit(1);

  return rows[0];
}

// One candidate scoped to its owner, as a DTO.
export async function getProposalCandidateForUser(
  db: DbClient,
  id: string,
  userId: string
): Promise<ProposalCandidateDto | undefined> {
  const row = await getProposalCandidateRowForUser(db, id, userId);

  return row === undefined ? undefined : toProposalCandidateDto(row);
}

// The user's proposal candidates, newest first (created_at desc, id as a stable tiebreak).
export async function listProposalCandidatesForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<ProposalCandidateDto>> {
  const rows = await db
    .select()
    .from(proposalCandidates)
    .where(eq(proposalCandidates.userId, userId))
    .orderBy(desc(proposalCandidates.createdAt), asc(proposalCandidates.id));

  return rows.map(toProposalCandidateDto);
}

// The reviews recorded for one of the user's candidates, oldest first. Scoped to the owner so another
// user's candidate id returns nothing.
export async function listProposalReviewsForCandidate(
  db: DbClient,
  candidateId: string,
  userId: string
): Promise<ReadonlyArray<ProposalReviewDto>> {
  const rows = await db
    .select()
    .from(proposalReviews)
    .where(
      and(eq(proposalReviews.proposalCandidateId, candidateId), eq(proposalReviews.userId, userId))
    )
    .orderBy(asc(proposalReviews.createdAt), asc(proposalReviews.id));

  return rows.map(toProposalReviewDto);
}
