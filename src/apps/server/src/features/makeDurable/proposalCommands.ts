import type {
  CreateProposalCandidateRequest,
  EnrollRecallItemRequest,
  ProposalCandidateDto,
  ProposalCandidateStatus,
  ProposalCandidateType,
  ProposalPayload,
  ProposalReviewDto,
  RecallItemDto,
  RecallKind,
  RecordProposalReviewRequest
} from "@whetstone/contracts";
import { parseProposalPayload } from "@whetstone/contracts";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
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
  | Readonly<{ candidate: ProposalCandidateDto; review: ProposalReviewDto; status: "recorded" }>
  | Readonly<{ status: "not_found" }>;

// Map each proposal type to the recall kind a saved item takes: a phrase/gap becomes a `phrase`, a
// recurring production fix becomes a `pattern`.
const recallKindByProposalType: Record<ProposalCandidateType, RecallKind> = {
  couldnt_say_gap: "phrase",
  phrase_chunk: "phrase",
  recurring_pattern: "pattern"
};

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

  return {
    candidate: await insertProposalCandidate(dependencies, request, userId, now),
    status: "created"
  };
}

// Persist a proposal candidate row and return its DTO. Assumes the caller has ALREADY established that
// `timeline_entry_id` belongs to `userId` (either via `createProposalCandidate`'s check, or because the
// caller just created that capture for the user, as Quick Capture does). Kept separate so the ownership
// gate is not double-run; an external caller with an unvalidated id must use `createProposalCandidate`.
export async function insertProposalCandidate(
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

  return {
    candidate: toProposalCandidateDto(candidate),
    review: toProposalReviewDto(row),
    status: "recorded"
  };
}

// The Make Durable save step: the ONLY path that stamps a recall item's `source_proposal_candidate_id`.
// It takes an ALREADY-owner-validated candidate (the caller resolved it via the current user, e.g. from
// `recordProposalReview`) and derives every recall field from it — kind from the proposal type, target/
// cue/use-context/category/tags from the payload (or the learner's edited payload on Edit + Save), and
// crucially `provenance_entry_id` from the candidate's own `timeline_entry_id`, so provenance can never
// cross-link to an unrelated or another user's capture. The validated candidate id is stamped inward.
export async function saveProposalRecallItem(
  dependencies: MakeDurableDependencies,
  candidate: ProposalCandidateDto,
  editedPayload: ProposalPayload | null,
  userId: string,
  now: Date
): Promise<RecallItemDto> {
  const payload = editedPayload ?? parseProposalPayload(candidate.payload);
  const request: EnrollRecallItemRequest = {
    kind: recallKindByProposalType[candidate.type],
    text: payload.target,
    gloss: payload.explanation ?? undefined,
    cue: payload.cue,
    useContext: payload.useContext,
    category: payload.category,
    tags: payload.tags ?? undefined,
    provenanceEntryId: candidate.timelineEntryId
  };

  return enrollRecallItem(dependencies, request, userId, now, candidate.id);
}

// Move one of the user's candidates to a new workflow status (e.g. `saved` after a save, `dismissed`
// after a negative review or when gated out). Scoped to the owner so a forged/foreign id updates
// nothing.
export async function setProposalCandidateStatus(
  db: DbClient,
  id: string,
  userId: string,
  status: ProposalCandidateStatus
): Promise<void> {
  await db
    .update(proposalCandidates)
    .set({ status })
    .where(and(eq(proposalCandidates.id, id), eq(proposalCandidates.userId, userId)));
}
