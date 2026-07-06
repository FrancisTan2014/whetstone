import type {
  CreateProposalCandidateRequest,
  ProposalCandidateDto,
  ProposalReviewDto,
  RecordProposalReviewRequest
} from "@whetstone/contracts";

import { proposalCandidates, proposalReviews } from "../../db/schema.js";
import type { MakeDurableDependencies } from "./timelineCommands.js";
import {
  getProposalCandidateRowForUser,
  toProposalCandidateDto,
  toProposalReviewDto
} from "./proposalQueries.js";

export type RecordProposalReviewResult =
  | Readonly<{ review: ProposalReviewDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>;

// Record a gated Make Durable suggestion for one of the user's captures. The candidate is workflow
// state, not durable learning material — it becomes a recall item only when reviewed and saved. The
// server owns the id and `created_at`; the user is stamped for ownership.
export async function createProposalCandidate(
  dependencies: MakeDurableDependencies,
  request: CreateProposalCandidateRequest,
  userId: string,
  now: Date
): Promise<ProposalCandidateDto> {
  const row = {
    id: dependencies.createId(),
    timelineEntryId: request.timelineEntryId,
    userId,
    type: request.type,
    status: request.status,
    confidence: request.confidence,
    reason: request.reason,
    evidenceQuote: request.evidenceQuote,
    payloadJson: request.payload,
    duplicateStatus: request.duplicateStatus,
    relatedRecallItemId: request.relatedRecallItemId ?? null,
    noveltyReason: request.noveltyReason ?? null,
    modelName: request.modelName,
    promptVersion: request.promptVersion,
    createdAt: now
  } as const;

  await dependencies.db.insert(proposalCandidates).values(row);

  return toProposalCandidateDto(row);
}

// Record the user's decision on a proposal. Scoped to the current user so a forged or another user's
// candidate id is rejected (`not_found`). This records the tuning signal and the correction (on
// `edited_saved`); it does NOT itself create a recall item — the caller enrolls one on a save outcome.
export async function recordProposalReview(
  dependencies: MakeDurableDependencies,
  request: RecordProposalReviewRequest,
  userId: string,
  now: Date
): Promise<RecordProposalReviewResult> {
  const candidate = await getProposalCandidateRowForUser(
    dependencies.db,
    request.proposalCandidateId,
    userId
  );

  if (candidate === undefined) {
    return { status: "not_found" };
  }

  const row = {
    id: dependencies.createId(),
    proposalCandidateId: request.proposalCandidateId,
    userId,
    outcome: request.outcome,
    feedbackTagsJson: request.feedbackTags ?? null,
    editedPayloadJson: request.editedPayload ?? null,
    createdAt: now
  } as const;

  await dependencies.db.insert(proposalReviews).values(row);

  return { review: toProposalReviewDto(row), status: "recorded" };
}
