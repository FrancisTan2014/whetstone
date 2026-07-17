import type { NotePromptSettingsDto } from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts } from "../../db/schema.js";
import { getPromptRowForUser } from "../memory/memoryQueries.js";
import {
  deleteReviewCard,
  pauseReviewCard,
  restartReviewCard,
  resumeReviewCard,
  seedReviewCard
} from "../review/reviewCardCommands.js";
import { getReviewCardForUser } from "../review/reviewCardQueries.js";
import { projectPromptSettings } from "./notesReviewSettingsProjection.js";

// What the Notes-owned Review-settings commands need: the database, the id stamp for any appended review
// event (only `restart` appends one), and an explicit clock so scheduling stays deterministic.
export type NoteReviewSettingsDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// The outcome of a single settings mutation: the prompt's refreshed settings row (so the client updates
// exactly that row), `not_found` when the prompt is not the caller's (404), or `conflict` when the card
// precondition no longer holds — a card-required action on a cardless prompt, or Add on a prompt that
// already has a card (409). The client refreshes the stale row instead of faking success.
export type NotePromptSettingsMutationOutcome =
  | Readonly<{ status: "ok"; value: NotePromptSettingsDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "conflict" }>;

// Edit one prompt's retrieval question (#660). Owner-scoped through the prompt's note facet, it writes ONLY
// the cue (rich doc + plaintext) — never the reveal policy, the card, its FSRS state, its due date, its
// requested retention, or its history. A `current_note` and a `legacy_custom` prompt edit their question
// identically; the reveal is untouched. Returns the refreshed row (the new question, the unchanged card
// state). `not_found` when the prompt is not the caller's.
export async function editNotePromptQuestion(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string,
  question: string
): Promise<NotePromptSettingsMutationOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }

  const cueDoc = createTextDocument(question);
  await dependencies.db
    .update(memoryPrompts)
    .set({ cueDoc, cueText: question })
    .where(eq(memoryPrompts.entryId, promptId));

  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  return {
    status: "ok",
    value: projectPromptSettings(
      { ...prompt, cueDoc, cueText: question },
      card,
      dependencies.now()
    )
  };
}

// Pause one prompt's card (#660): withhold it from the due scan without touching its FSRS state or writing
// a review event. Owner-scoped. `conflict` when the prompt has no card (a stale row that should be
// re-listed). Returns the refreshed row (now `paused`).
export async function pauseNotePrompt(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string
): Promise<NotePromptSettingsMutationOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  const result = await pauseReviewCard(dependencies.db, promptId, userId, dependencies.now());
  if (result.status === "not_found") {
    return { status: "conflict" };
  }
  return {
    status: "ok",
    value: projectPromptSettings(prompt, result.card, dependencies.now())
  };
}

// Resume one prompt's paused card (#660): return it to the due scan without touching its FSRS state or
// writing a review event. Owner-scoped. `conflict` when the prompt has no card. Returns the refreshed row.
export async function resumeNotePrompt(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string
): Promise<NotePromptSettingsMutationOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  const result = await resumeReviewCard(dependencies.db, promptId, userId, dependencies.now());
  if (result.status === "not_found") {
    return { status: "conflict" };
  }
  return {
    status: "ok",
    value: projectPromptSettings(prompt, result.card, dependencies.now())
  };
}

// Restart one prompt's schedule (#660): reset the card to a brand-new FSRS state and append exactly one
// `reset` review event, through the EXISTING Review boundary (`restartReviewCard`) — never re-implementing
// FSRS and never inventing a rating. Owner-scoped. `conflict` when the prompt has no card. Returns the
// refreshed row (now due immediately).
export async function restartNotePrompt(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string
): Promise<NotePromptSettingsMutationOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  const result = await restartReviewCard(
    { createId: dependencies.createId, db: dependencies.db },
    promptId,
    userId,
    dependencies.now()
  );
  if (result.status === "not_found") {
    return { status: "conflict" };
  }
  return {
    status: "ok",
    value: projectPromptSettings(prompt, result.card, dependencies.now())
  };
}

// Remove one prompt's card from Review (#660): drop the card but KEEP the note and the append-only review
// history, through the EXISTING Review boundary (`deleteReviewCard`), so the record survives a later
// re-add. Owner-scoped, verified against the card's owner before deleting. `conflict` when the prompt has no
// card. Returns the refreshed row (now `not_in_review`, offering "Add to review").
export async function removeNotePromptCard(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string
): Promise<NotePromptSettingsMutationOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  if (card === undefined) {
    return { status: "conflict" };
  }
  await dependencies.db.transaction((tx) => deleteReviewCard(tx, promptId));
  return {
    status: "ok",
    value: projectPromptSettings(prompt, undefined, dependencies.now())
  };
}

// Re-add a cardless prompt to Review (#660): seed ONE fresh active shared card at the recall retention, due
// now, through the EXISTING Review boundary (`seedReviewCard`) — reusing the SAME prompt (no duplicate, no
// new prompt direction) and its preserved history. No review event is written (a seed is not a review).
// Owner-scoped. `conflict` when the prompt already has a card — the row should offer Resume/Review, not
// Add. Returns the refreshed row (now due immediately).
export async function addNotePromptCard(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string
): Promise<NotePromptSettingsMutationOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  const existing = await getReviewCardForUser(dependencies.db, promptId, userId);
  if (existing !== undefined) {
    return { status: "conflict" };
  }
  const now = dependencies.now();
  await dependencies.db.transaction((tx) =>
    seedReviewCard(tx, {
      targetEntryId: promptId,
      userId,
      requestedRetention: RECALL_REQUEST_RETENTION,
      now
    })
  );
  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  return { status: "ok", value: projectPromptSettings(prompt, card, now) };
}
