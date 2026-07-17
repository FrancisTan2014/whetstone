import type { NoteReviewRatingResultDto } from "@whetstone/contracts";
import type { ReviewRating } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { getPromptRowForUser } from "./notePromptQueries.js";
import { rateReviewCard } from "../review/reviewCardCommands.js";
import { countDueNotePrompts } from "./notesReviewQueries.js";

// What a Notes-owned rating needs: the database and the id stamp for the appended review event. The clock
// is passed explicitly (`now`) so scheduling stays deterministic.
export type NoteReviewCommandDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
}>;

// The outcome of rating one prompt: the rescheduled card's next FSRS state plus `remainingDue` (the
// learner's still-due prompt count AFTER this rating), or `not_found` when the prompt is not the caller's
// or carries no card (paused/unenrolled) — the route maps that to 404.
export type RateNotePromptResult =
  | Readonly<{
      remainingDue: number;
      review: NoteReviewRatingResultDto["review"];
      status: "rated";
    }>
  | Readonly<{ status: "not_found" }>;

// Rate exactly one prompt in a Notes-owned session (#657). Ownership is checked through the prompt's note
// facet first, then the rating is applied to that prompt's shared review card through the EXISTING Review
// boundary (`rateReviewCard`) — the session never re-implements FSRS or scheduling. Only that one prompt's
// card is rescheduled; the returned state's `due` is the next scheduled date the session shows, and
// `remainingDue` counts the prompts still due afterwards so the session can close out the batch without an
// extra advance. A prompt with no card owned by the user is `not_found`.
export async function rateNotePrompt(
  dependencies: NoteReviewCommandDependencies,
  promptId: string,
  rating: ReviewRating,
  userId: string,
  now: Date
): Promise<RateNotePromptResult> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  const result = await rateReviewCard(
    { createId: dependencies.createId, db: dependencies.db },
    promptId,
    userId,
    rating,
    now
  );
  if (result.status === "not_found") {
    return { status: "not_found" };
  }
  const remainingDue = await countDueNotePrompts(dependencies.db, userId, now);
  return { remainingDue, review: result.state, status: "rated" };
}
