import type { NoteGradingTarget, NotePromptSettingsDto } from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION } from "@whetstone/domain";
import { type DocumentNodeJSON, documentReadableText } from "@whetstone/document";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts } from "../../db/schema.js";
import { resolveGradingColumns } from "./noteGradingColumns.js";
import { getPromptRowForUser } from "./notePromptQueries.js";
import {
  applyResetToCardInTx,
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

// The outcome of editing a prompt's retrieval question (#660, made rich in #687). `ok` returns the
// refreshed settings row. `not_found` (404) is a prompt that is not the caller's. `invalid_question` (400)
// is a Question document whose server-derived text is blank — the wire never carries plaintext, so blankness
// is judged here, and a blank cue is rejected before any write.
export type EditNotePromptQuestionOutcome =
  | Readonly<{ status: "ok"; value: NotePromptSettingsDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "invalid_question" }>;

// Edit one prompt's retrieval question (#660, rich in #687). Owner-scoped through the prompt's note facet, it
// writes ONLY the cue (rich doc + derived plaintext) — never the reveal policy, the card, its FSRS state, its
// due date, its requested retention, or its history. A `current_note`, an `expected_response`, and a
// `legacy_custom` prompt edit their question identically; the reveal is untouched. The Question text is
// derived here, never trusted from the client, and a blank document is rejected as `invalid_question`.
// Returns the refreshed row (the new question, the unchanged card state). `not_found` when the prompt is not
// the caller's.
export async function editNotePromptQuestion(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string,
  questionDoc: unknown
): Promise<EditNotePromptQuestionOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }

  const cueDoc = questionDoc as DocumentNodeJSON;
  const cueText = documentReadableText(cueDoc);
  if (cueText.trim().length === 0) {
    return { status: "invalid_question" };
  }

  await dependencies.db
    .update(memoryPrompts)
    .set({ cueDoc, cueText })
    .where(eq(memoryPrompts.entryId, promptId));

  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  return {
    status: "ok",
    value: projectPromptSettings({ ...prompt, cueDoc, cueText }, card, dependencies.now())
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

// The outcome of setting a prompt's grading target (#686). `ok` returns the refreshed settings row.
// `not_found` (404) is a prompt that is not the caller's. `invalid_success_check` (400) is an
// expected-response target whose Success check is blank once its text is derived server-side.
// `legacy_read_only` (409) rejects any change through this boundary to a `legacy_custom` prompt — legacy
// reveals are preserved, never converted (#657). `restart_requires_card` (409) rejects a `restart`
// on a cardless prompt: a schedule reset needs a card, and this boundary never fabricates one.
export type SetNoteGradingTargetOutcome =
  | Readonly<{ status: "ok"; value: NotePromptSettingsDto }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "invalid_success_check" }>
  | Readonly<{ status: "legacy_read_only" }>
  | Readonly<{ status: "restart_requires_card" }>;

// The persisted answer columns a grading target resolves to live in `noteGradingColumns.ts`, the single
// reveal-column policy shared by this command (#686) and the direct card command (#689).

// Set a prompt's grading target (#686): declare whether it grades against the live note (`current_note`) or
// an authored Success check (`expected_response`), and — atomically in ONE transaction — persist the reveal
// policy and, when `mode` is `restart`, reset the schedule through the shared Review boundary
// (`applyResetToCardInTx`: one `reset` event, due now). `keep` writes only the policy and never touches the
// card, due date, requested retention, or history. Owner-scoped through the prompt's note facet. A
// `legacy_custom` prompt is read-only here (`legacy_read_only`); a `restart` on a cardless prompt is a
// `restart_requires_card` conflict (this boundary never fabricates a card). A blank Success check is
// `invalid_success_check`. Any rejection returns BEFORE the transaction, so content and schedule/history are
// left unchanged. Returns the refreshed settings row.
export async function setNoteGradingTarget(
  dependencies: NoteReviewSettingsDependencies,
  promptId: string,
  userId: string,
  request: Readonly<{ mode: "keep" | "restart"; target: NoteGradingTarget }>
): Promise<SetNoteGradingTargetOutcome> {
  const prompt = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (prompt === undefined) {
    return { status: "not_found" };
  }
  if (prompt.revealKind === "legacy_custom") {
    return { status: "legacy_read_only" };
  }

  const resolved = resolveGradingColumns(request.target);
  if (resolved.status === "invalid_success_check") {
    return { status: "invalid_success_check" };
  }

  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  if (request.mode === "restart" && card === undefined) {
    return { status: "restart_requires_card" };
  }

  const now = dependencies.now();
  const nextColumns = {
    revealKind: resolved.revealKind,
    answerDoc: resolved.answerDoc,
    answerText: resolved.answerText,
    lifecycle: "ready" as const
  };
  let finalCard = card;
  await dependencies.db.transaction(async (tx) => {
    await tx.update(memoryPrompts).set(nextColumns).where(eq(memoryPrompts.entryId, promptId));
    if (request.mode === "restart" && card !== undefined) {
      const reset = await applyResetToCardInTx(tx, card, now, dependencies.createId());
      finalCard = reset.card;
    }
  });

  return {
    status: "ok",
    value: projectPromptSettings(
      {
        ...prompt,
        revealKind: resolved.revealKind,
        answerDoc: resolved.answerDoc,
        answerText: resolved.answerText
      },
      finalCard,
      now
    )
  };
}
