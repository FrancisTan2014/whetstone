import type {
  CreateProposalCandidateRequest,
  EnrollRecallItemRequest,
  ProposalCandidateDto,
  ProposalReviewDto,
  RecallItemDto,
  RecordProposalReviewRequest
} from "@whetstone/contracts";

import { proposalCandidates, proposalReviews } from "../../db/schema.js";
import { enrollRecallItem } from "../recall/recallCommands.js";
import type { MakeDurableDependencies } from "./timelineCommands.js";
import {
  getProposalCandidateRowForUser,
  toProposalCandidateDto,
  toProposalReviewDto
} from "./proposalQueries.js";
import { getTimelineCaptureForUser } from "./timelineQueries.js";

export type CreateProposalCandidateResult =
  | Readonly<{ candidate: ProposalCandidateDto; status: "created" }>
  | Readonly<{ status: "timeline_not_found" }>;

export type RecordProposalReviewResult =
  | Readonly<{ review: ProposalReviewDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>;

export type SaveProposalRecallResult =
  | Readonly<{ item: RecallItemDto; status: "saved" }>
  | Readonly<{ status: "proposal_not_found" }>
  | Readonly<{ status: "provenance_mismatch" }>;

// Record a gated Make Durable suggestion for one of the user's captures. The candidate is workflow
// state, not durable learning material — it becomes a recall item only when reviewed and saved. The
// server owns the id and `created_at`; the user is stamped for ownership.
//
// The target `timeline_entry_id` is scoped to the current user (`getTimelineCaptureForUser`) BEFORE
// insert: the DB foreign key only proves the capture exists, so without this a user could attach a
// candidate to another user's capture (a known entry id) and later cross user-owned Timeline data
// through provenance. A capture owned by someone else (or a forged id) yields `timeline_not_found`.
export async function createProposalCandidate(
  dependencies: MakeDurableDependencies,
  request: CreateProposalCandidateRequest,
  userId: string,
  now: Date
): Promise<CreateProposalCandidateResult> {
  const timelineEntry = await getTimelineCaptureForUser(
    dependencies.db,
    request.timelineEntryId,
    userId
  );

  if (timelineEntry === undefined) {
    return { status: "timeline_not_found" };
  }

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

  return { candidate: toProposalCandidateDto(row), status: "created" };
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

// The Make Durable save boundary: the ONLY sanctioned path that stamps a recall item's
// `source_proposal_candidate_id`. It enforces the integrity the raw `enrollRecallItem` cannot:
//   1. the proposal candidate exists AND is owned by the current user (`proposal_not_found` otherwise —
//      a forged or another user's candidate id is rejected), and
//   2. the recall item's provenance points at the SAME timeline entry the proposal came from
//      (`provenance_mismatch` when `request.provenanceEntryId` !== the candidate's `timeline_entry_id`),
// so provenance can never cross-link to an unrelated (or another user's) capture. Only then does it
// enroll the recall item, passing the validated candidate id inward.
export async function saveProposalRecallItem(
  dependencies: MakeDurableDependencies,
  proposalCandidateId: string,
  request: EnrollRecallItemRequest,
  userId: string,
  now: Date
): Promise<SaveProposalRecallResult> {
  const candidate = await getProposalCandidateRowForUser(
    dependencies.db,
    proposalCandidateId,
    userId
  );

  if (candidate === undefined) {
    return { status: "proposal_not_found" };
  }

  if (request.provenanceEntryId !== candidate.timelineEntryId) {
    return { status: "provenance_mismatch" };
  }

  const item = await enrollRecallItem(dependencies, request, userId, now, candidate.id);

  return { item, status: "saved" };
}
