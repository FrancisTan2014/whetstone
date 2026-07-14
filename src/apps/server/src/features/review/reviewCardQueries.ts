import type { ReviewState } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { reviewCards } from "../../db/schema.js";

// One persisted review-card row, as selected from its table. Every FSRS field is non-null (a card is
// complete); `lastReviewedAt` is the only nullable one (null until the first review).
export type ReviewCardRow = typeof reviewCards.$inferSelect;

// The FSRS columns of a card, mapped from the domain `ReviewState` (ISO -> Date). Shared by every write
// path so seed/rate/restart persist the card's state through one boundary.
export type ReviewStateColumns = Readonly<{
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  state: ReviewState["state"];
  dueAt: Date;
  lastReviewedAt: Date | null;
}>;

// Map a domain `ReviewState` onto the review-card FSRS columns (ISO -> Date) for insert/update.
export function reviewStateColumns(state: ReviewState): ReviewStateColumns {
  return {
    stability: state.stability,
    difficulty: state.difficulty,
    elapsedDays: state.elapsedDays,
    scheduledDays: state.scheduledDays,
    learningSteps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    dueAt: new Date(state.due),
    lastReviewedAt: state.lastReviewedAt === null ? null : new Date(state.lastReviewedAt)
  };
}

// Reconstruct the domain `ReviewState` from a card row (Date -> ISO; null last-reviewed preserved), so a
// consumer can render the card's schedule or apply a rating through `@whetstone/domain`. This is the
// single seam any reader uses to interpret a persisted card — no consumer re-maps the columns itself.
export function reviewStateFromCard(row: ReviewCardRow): ReviewState {
  return {
    due: row.dueAt.toISOString(),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    lapses: row.lapses,
    reps: row.reps,
    state: row.state,
    lastReviewedAt: row.lastReviewedAt === null ? null : row.lastReviewedAt.toISOString()
  };
}

// One card scoped to its owner (the card's `user_id`), used to authorize a rating/restart/snooze/pause/
// resume or to read its schedule. Undefined when no card exists for the target, or it is owned by someone
// else — so a caller can never touch another user's schedule.
export async function getReviewCardForUser(
  db: DbClient,
  targetEntryId: string,
  userId: string
): Promise<ReviewCardRow | undefined> {
  const rows = await db
    .select()
    .from(reviewCards)
    .where(and(eq(reviewCards.targetEntryId, targetEntryId), eq(reviewCards.userId, userId)))
    .limit(1);
  return rows[0];
}
