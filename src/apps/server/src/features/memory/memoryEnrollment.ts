import type { EnrollNoteRequest, MemoryPromptDto, NoteReviewDto } from "@whetstone/contracts";
import { buildMemoryPrompt, RECALL_REQUEST_RETENTION, toEntryId } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, entryLinks, memoryPrompts, personalEntries } from "../../db/schema.js";
import {
  pauseReviewCard,
  restartReviewCard,
  resumeReviewCard,
  seedReviewCard
} from "../review/reviewCardCommands.js";
import { getReviewCardForUser } from "../review/reviewCardQueries.js";
import type { MemoryDependencies } from "./memoryCommands.js";
import {
  findMatchingPromptRow,
  getMemoryPromptForUser,
  getOwnedNoteRowForUser,
  getPromptRowForUser,
  listNoteReviewPrompts,
  type MemoryPromptRow
} from "./memoryQueries.js";

// Enrolling a note in review returns the note's full, refreshed review list (every prompt with its card
// state), so the client updates the Reader panel / Notes row in one round-trip. A missing or non-owned
// note is `not_found` — one user can never enroll another's note.
export type EnrollNoteResult =
  | Readonly<{ review: NoteReviewDto; status: "enrolled" }>
  | Readonly<{ status: "not_found" }>;

// Enrolling a single imported prompt (a ready-but-cardless prompt from a paste import, #575): success
// returns the now-enrolled prompt. `not_found` (missing/non-owned), `not_ready` (a draft has no revealable
// answer, so there is nothing to schedule), and `already_enrolled` (it already has a card) are the
// no-op outcomes the route maps to distinct statuses.
export type EnrollPromptResult =
  | Readonly<{ prompt: MemoryPromptDto; status: "enrolled" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_ready" }>
  | Readonly<{ status: "already_enrolled" }>;

// Pausing, resuming, or restarting a prompt's schedule returns the updated prompt. `not_found` is a
// missing/non-owned prompt; `not_scheduled` is a prompt with no card (a draft or an unenrolled import) —
// there is no schedule to control.
export type PromptScheduleResult =
  | Readonly<{ prompt: MemoryPromptDto; status: "updated" }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_scheduled" }>;

// Read a note's review settings: the note and every prompt hanging off it, each with its card state +
// status, for the Reader panel / Notes overview review view. Undefined when the note does not exist, is a
// mark, or is not owned. Any owned note — anchored (a Reader note) or unanchored — is a valid target.
export async function getNoteReview(
  db: DbClient,
  userId: string,
  noteId: string
): Promise<NoteReviewDto | undefined> {
  const note = await getOwnedNoteRowForUser(db, userId, noteId);
  if (note === undefined) {
    return undefined;
  }
  const prompts = await listNoteReviewPrompts(db, noteId);
  return { noteId, prompts: [...prompts] };
}

// Build the persisted prompt row for an enrollment. The learner's confirmed cue AND reveal are always
// present and non-blank (the request boundary guarantees it), so the domain lifecycle is always `ready`;
// the rich `cueDoc`/`answerDoc` the compact editor produced are used when supplied, else derived from the
// text — matching how every other prompt row is built.
function buildEnrollPromptRow(
  promptId: string,
  noteId: string,
  request: EnrollNoteRequest,
  now: Date
): MemoryPromptRow {
  const built = buildMemoryPrompt({
    id: toEntryId(promptId),
    noteId: toEntryId(noteId),
    cueText: request.cueText,
    answerText: request.answerText,
    chunkId: null
  });
  return {
    entryId: promptId,
    noteEntryId: noteId,
    cueDoc: request.cueDoc ?? createTextDocument(request.cueText),
    cueText: request.cueText,
    answerDoc: request.answerDoc ?? createTextDocument(request.answerText),
    answerText: request.answerText,
    lifecycle: built.lifecycle,
    chunkId: null,
    createdAt: now
  };
}

// Explicitly enroll a note in review from the "Add to review" cue/reveal confirmation (#575): create one
// ready prompt and one active 0.90 review card for the note, atomically, and bump the note's `updatedAt`.
//
// Idempotent by design so a double-submit (double-click / retry) never creates a duplicate: if the note
// already has a prompt whose cue AND reveal match this exact pair, the existing prompt is reused — and if
// that match is a still-cardless import, it is enrolled (its card seeded) rather than duplicated. A
// different cue/reveal pair is a genuinely new retrieval direction and adds another prompt.
export async function enrollNote(
  dependencies: MemoryDependencies,
  noteId: string,
  userId: string,
  request: EnrollNoteRequest,
  now: Date
): Promise<EnrollNoteResult> {
  const note = await getOwnedNoteRowForUser(dependencies.db, userId, noteId);
  if (note === undefined) {
    return { status: "not_found" };
  }

  const match = await findMatchingPromptRow(
    dependencies.db,
    noteId,
    request.cueText,
    request.answerText
  );

  if (match !== undefined) {
    const card = await getReviewCardForUser(dependencies.db, match.entryId, userId);
    if (card === undefined) {
      // The identical pair already exists as a cardless import — enroll it in place, don't duplicate.
      await dependencies.db.transaction((tx) =>
        seedReviewCard(tx, {
          targetEntryId: match.entryId,
          userId,
          requestedRetention: RECALL_REQUEST_RETENTION,
          now
        })
      );
    }
    // else: already enrolled — the deliberate re-submit is a no-op.
  } else {
    const promptRow = buildEnrollPromptRow(dependencies.createId(), noteId, request, now);
    await dependencies.db.transaction(async (tx) => {
      await tx.insert(entries).values({ id: promptRow.entryId, type: "memory_prompt" });
      await tx.insert(memoryPrompts).values(promptRow);
      await tx.insert(entryLinks).values({
        fromEntryId: noteId,
        toEntryId: promptRow.entryId,
        type: "contains"
      });
      await seedReviewCard(tx, {
        targetEntryId: promptRow.entryId,
        userId,
        requestedRetention: RECALL_REQUEST_RETENTION,
        now
      });
      await tx
        .update(personalEntries)
        .set({ updatedAt: now })
        .where(eq(personalEntries.entryId, noteId));
    });
  }

  const prompts = await listNoteReviewPrompts(dependencies.db, noteId);
  return { review: { noteId, prompts: [...prompts] }, status: "enrolled" };
}

// Enroll a single imported prompt that landed ready but cardless (#575): seed its active 0.90 card so it
// enters the due schedule. A draft (no revealable answer) is `not_ready`; an already-carded prompt is
// `already_enrolled`; a missing/non-owned prompt is `not_found`. All three are no-ops.
export async function enrollPrompt(
  dependencies: MemoryDependencies,
  promptId: string,
  userId: string,
  now: Date
): Promise<EnrollPromptResult> {
  const row = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  if (row.lifecycle !== "ready") {
    return { status: "not_ready" };
  }
  const card = await getReviewCardForUser(dependencies.db, promptId, userId);
  if (card !== undefined) {
    return { status: "already_enrolled" };
  }
  await dependencies.db.transaction((tx) =>
    seedReviewCard(tx, {
      targetEntryId: promptId,
      userId,
      requestedRetention: RECALL_REQUEST_RETENTION,
      now
    })
  );
  const prompt = await getMemoryPromptForUser(dependencies.db, promptId, userId);
  // The prompt exists and is owned (just re-read under the same user scope), so the DTO is always present.
  return { prompt: prompt as MemoryPromptDto, status: "enrolled" };
}

// Shared control for the three schedule transitions after enrollment (#575): authorize the prompt, run
// the card transition, and project the refreshed prompt. A prompt with no card is `not_scheduled` — there
// is no schedule to pause/resume/restart.
async function transitionPromptSchedule(
  dependencies: MemoryDependencies,
  promptId: string,
  userId: string,
  transition: () => Promise<Readonly<{ status: string }>>
): Promise<PromptScheduleResult> {
  const row = await getPromptRowForUser(dependencies.db, promptId, userId);
  if (row === undefined) {
    return { status: "not_found" };
  }
  const result = await transition();
  if (result.status === "not_found") {
    return { status: "not_scheduled" };
  }
  const prompt = await getMemoryPromptForUser(dependencies.db, promptId, userId);
  return { prompt: prompt as MemoryPromptDto, status: "updated" };
}

// Pause a prompt's schedule: withhold its active card from the due scan without touching the FSRS state,
// so it stops appearing for review until resumed. See `transitionPromptSchedule` for the outcomes.
export function pausePrompt(
  dependencies: MemoryDependencies,
  promptId: string,
  userId: string,
  now: Date
): Promise<PromptScheduleResult> {
  return transitionPromptSchedule(dependencies, promptId, userId, () =>
    pauseReviewCard(dependencies.db, promptId, userId, now)
  );
}

// Resume a paused prompt: return its card to the due scan, preserving its due date and FSRS history
// exactly — resuming never resets the schedule. See `transitionPromptSchedule` for the outcomes.
export function resumePrompt(
  dependencies: MemoryDependencies,
  promptId: string,
  userId: string,
  now: Date
): Promise<PromptScheduleResult> {
  return transitionPromptSchedule(dependencies, promptId, userId, () =>
    resumeReviewCard(dependencies.db, promptId, userId, now)
  );
}

// Restart a prompt's schedule: reset its card to a brand-new FSRS state (due now) and record a `reset`
// event, without inventing a rating. See `transitionPromptSchedule` for the outcomes.
export function restartPrompt(
  dependencies: MemoryDependencies,
  promptId: string,
  userId: string,
  now: Date
): Promise<PromptScheduleResult> {
  return transitionPromptSchedule(dependencies, promptId, userId, () =>
    restartReviewCard(dependencies, promptId, userId, now)
  );
}
