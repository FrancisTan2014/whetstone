import type { JsonObject, RecallItemDto, ReviewProposalRequest } from "@whetstone/contracts";

import {
  recordProposalReview,
  saveProposalRecallItem,
  setProposalCandidateStatus
} from "./proposalCommands.js";
import type { MakeDurableDependencies } from "./timelineCommands.js";

export type ReviewProposalCardResult =
  | Readonly<{ recallItem: RecallItemDto; status: "saved" }>
  | Readonly<{ recallItem: null; status: "dismissed" }>
  | Readonly<{ status: "not_found" }>;

function isSaveOutcome(outcome: ReviewProposalRequest["outcome"]): boolean {
  return outcome === "saved" || outcome === "edited_saved";
}

// Act on a Today review card (#452): the single review boundary the endpoint drives. It records the
// review (the tuning signal + correction), which also authorizes the current user — a forged/foreign
// candidate id yields `not_found`. On Save / Edit + Save it makes the item durable through
// `saveProposalRecallItem` (recall invariants preserved, provenance → the source Timeline entry, source
// candidate stamped) and marks the candidate `saved`; on Not-useful-now / Wrong / Ignore it creates no
// recall item and marks the candidate `dismissed`. Either way the card leaves Today.
export async function reviewProposalCard(
  dependencies: MakeDurableDependencies,
  candidateId: string,
  request: ReviewProposalRequest,
  userId: string,
  now: Date
): Promise<ReviewProposalCardResult> {
  const recorded = await recordProposalReview(
    dependencies,
    {
      proposalCandidateId: candidateId,
      outcome: request.outcome,
      feedbackTags: request.feedbackTags ?? null,
      editedPayload: (request.editedPayload ?? null) as JsonObject | null
    },
    userId,
    now
  );

  if (recorded.status === "not_found") {
    return { status: "not_found" };
  }

  if (isSaveOutcome(request.outcome)) {
    const recallItem = await saveProposalRecallItem(
      dependencies,
      recorded.candidate,
      request.editedPayload ?? null,
      userId,
      now
    );
    await setProposalCandidateStatus(dependencies.db, candidateId, userId, "saved");
    return { recallItem, status: "saved" };
  }

  await setProposalCandidateStatus(dependencies.db, candidateId, userId, "dismissed");
  return { recallItem: null, status: "dismissed" };
}
