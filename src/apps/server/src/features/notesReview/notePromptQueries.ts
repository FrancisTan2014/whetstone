import { localDayBoundary } from "@whetstone/domain";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts, personalEntries, reviewCards } from "../../db/schema.js";

// A note prompt row as the Notes-owned Review surface reads it (#662). It is a row of the retained
// `memory_prompts` table (the storage name is kept for migration continuity — see PRODUCT "v0 content
// model"), but the standalone Memory experience it once backed is gone: prompts are now created and
// scheduled only through Notes + the shared Review substrate. A prompt row holds no scheduling state of
// its own — the FSRS card lives in the shared `review_cards` substrate (#617).
export type NotePromptRow = typeof memoryPrompts.$inferSelect;

// One prompt row scoped to its owner (the owning note's `personal_entries` user), used to authorize a
// review or fetch. Returns the raw row so a caller can pair it with its shared review card. A prompt that
// is missing or owned by someone else yields undefined, so ownership is never leaked.
export async function getPromptRowForUser(
  db: DbClient,
  promptId: string,
  userId: string
): Promise<NotePromptRow | undefined> {
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(and(eq(memoryPrompts.entryId, promptId), eq(personalEntries.userId, userId)))
    .limit(1);

  return rows[0]?.prompt;
}

// The learner's note-review routine as Today's board reads it (#610): one grouped summary over the user's
// enrolled note prompts' active review cards — how many are due now (`due_at` <= now), how many are
// overdue (due before the local day started, #606), and the earliest due instant (null when nothing is
// due). Paused/snoozed prompts are simply prompts whose card is not yet due, so they fall out naturally.
// A single scoped read of the active cards' due instants; the counts are folded in memory so the whole
// routine costs one round-trip.
export async function loadNoteReviewRoutineSummary(
  db: DbClient,
  userId: string,
  now: Date,
  timeZone: string
): Promise<Readonly<{ dueCount: number; nextDueAt: string | null; overdueCount: number }>> {
  const rows = await db
    .select({ dueAt: reviewCards.dueAt })
    .from(reviewCards)
    .innerJoin(memoryPrompts, eq(reviewCards.targetEntryId, memoryPrompts.entryId))
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(and(eq(personalEntries.userId, userId), eq(reviewCards.status, "active")));

  const { utcStart } = localDayBoundary(now, timeZone);
  const nowMs = now.getTime();
  const dayStartMs = utcStart.getTime();
  let dueCount = 0;
  let overdueCount = 0;
  let earliestDueMs: number | null = null;
  for (const row of rows) {
    const dueMs = row.dueAt.getTime();
    if (dueMs > nowMs) {
      continue;
    }
    dueCount += 1;
    if (dueMs < dayStartMs) {
      overdueCount += 1;
    }
    if (earliestDueMs === null || dueMs < earliestDueMs) {
      earliestDueMs = dueMs;
    }
  }
  return {
    dueCount,
    nextDueAt: earliestDueMs === null ? null : new Date(earliestDueMs).toISOString(),
    overdueCount
  };
}
