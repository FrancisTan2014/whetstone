import {
  parseProposalPayload,
  type JsonObject,
  type ProposalCandidateDto,
  type ProposalReviewDto
} from "@whetstone/contracts";
import type { ReviewedProposalExample } from "@whetstone/domain";
import { and, asc, desc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { proposalCandidates, proposalReviews } from "../../db/schema.js";

// How many of the user's most-recent proposal reviews the policy layer (#457) pulls before the pure
// domain selection narrows them to a bounded, type-diverse few-shot set. Bounds the DB read so the
// lookback never grows with the full review history.
export const POLICY_REVIEW_LOOKBACK = 40;

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

// The learner's most-recent reviewed proposals, distilled to policy examples for the proposal prompt
// (#457). Joins each review to its candidate (both user-scoped) and projects the decision + the kept
// payload — the learner's EDITED payload when the review carried one (Edit + Save), otherwise the
// candidate's own payload. Newest first (so the pure `selectPolicyExamples` can keep the most-recent on a
// duplicate), bounded by `limit`. Payloads were schema-validated on write, so `parseProposalPayload`
// only re-narrows the stored JSON.
export async function listReviewedProposalExamples(
  db: DbClient,
  userId: string,
  limit: number
): Promise<ReadonlyArray<ReviewedProposalExample>> {
  const rows = await db
    .select({
      outcome: proposalReviews.outcome,
      type: proposalCandidates.type,
      payloadJson: proposalCandidates.payloadJson,
      editedPayloadJson: proposalReviews.editedPayloadJson
    })
    .from(proposalReviews)
    .innerJoin(proposalCandidates, eq(proposalReviews.proposalCandidateId, proposalCandidates.id))
    .where(eq(proposalReviews.userId, userId))
    .orderBy(desc(proposalReviews.createdAt), desc(proposalReviews.id))
    .limit(limit);

  return rows.map((row) => {
    const payload = parseProposalPayload(row.editedPayloadJson ?? row.payloadJson);
    return {
      outcome: row.outcome,
      type: row.type,
      category: payload.category,
      target: payload.target,
      useContext: payload.useContext,
      tags: payload.tags ?? []
    };
  });
}
