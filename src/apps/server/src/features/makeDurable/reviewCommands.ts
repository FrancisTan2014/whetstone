import type { JsonObject, RecallItemDto, ReviewProposalRequest } from "@whetstone/contracts";

import {
  promoteOldestPendingCandidate,
  recordProposalReview,
  saveProposalRecallItem,
  setProposalCandidateStatus
} from "./proposalCommands.js";
import { getProposalCandidateForUser } from "./proposalQueries.js";
import type { MakeDurableDependencies } from "./timelineCommands.js";

export type ReviewProposalCardResult =
  | Readonly<{ recallItem: RecallItemDto; status: "saved" }>
  | Readonly<{ recallItem: null; status: "dismissed" }>
  | Readonly<{ status: "not_found" }>;

function isSaveOutcome(outcome: ReviewProposalRequest["outcome"]): boolean {
  return outcome === "saved" || outcome === "edited_saved";
}

// Act on a Today review card (#452): the single review boundary the endpoint drives. A review is valid
// ONLY for a candidate that is still `visible` — a forged/foreign id, or any stale/repeat POST on a
// candidate already `saved`/`dismissed` (a double-click or retry), yields `not_found` and does nothing,
// so a card can never produce duplicate reviews or duplicate Recall items. On Save / Edit + Save it makes
// the item durable via `saveProposalRecallItem` (recall invariants preserved, provenance → the source
// Timeline entry) and marks the candidate `saved`; on Not-useful-now / Wrong / Ignore it records the
// signal only and marks it `dismissed`. Either way the card leaves Today and any held (`pending`)
// candidate is promoted to take its place.
export async function reviewProposalCard(
  dependencies: MakeDurableDependencies,
  candidateId: string,
  request: ReviewProposalRequest,
  userId: string,
  now: Date
): Promise<ReviewProposalCardResult> {
  const candidate = await getProposalCandidateForUser(dependencies.db, candidateId, userId);

  if (candidate === undefined || candidate.status !== "visible") {
    return { status: "not_found" };
  }

  await recordProposalReview(
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

  if (isSaveOutcome(request.outcome)) {
    const recallItem = await saveProposalRecallItem(
      dependencies,
      candidate,
      request.editedPayload ?? null,
      userId,
      now
    );
    await setProposalCandidateStatus(dependencies.db, candidateId, userId, "saved");
    await promoteOldestPendingCandidate(dependencies.db, userId);
    return { recallItem, status: "saved" };
  }

  await setProposalCandidateStatus(dependencies.db, candidateId, userId, "dismissed");
  await promoteOldestPendingCandidate(dependencies.db, userId);
  return { recallItem: null, status: "dismissed" };
}
