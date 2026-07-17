import type { NoteReviewEnrollmentStatusDto } from "@whetstone/contracts";
import { RECALL_REQUEST_RETENTION, type EntryId } from "@whetstone/domain";
import { createTextDocument } from "@whetstone/document";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  entries,
  entryLinks,
  memoryPrompts,
  personalEntries,
  reviewCards
} from "../../db/schema.js";
import { getNoteEnrollmentTarget, getNoteForOwner } from "../notes/noteQueries.js";
import { seedReviewCard } from "../review/reviewCardCommands.js";
import { type ReviewCardRow } from "../review/reviewCardQueries.js";

// A reader that both the DbClient (status read) and a transaction (enrollment read under the lock) satisfy,
// so the current-note-prompt and card lookups have one implementation usable on either handle.
type Reader = Pick<DbClient, "select">;

export type NoteReviewEnrollmentDependencies = Readonly<{
  createId: () => string;
  db: DbClient;
  now: () => Date;
}>;

// The outcome of authorizing a note for enrollment/status: the note is the user's saved anchored `note`
// (`ok`), does not exist for this user/work or is unanchored (`not_found`), or is a bodyless Mark that is
// never a retrieval target (`not_enrollable`).
export type NoteReviewOutcome<T> =
  | Readonly<{ status: "ok"; value: T }>
  | Readonly<{ status: "not_found" }>
  | Readonly<{ status: "not_enrollable" }>;

// Project a note's Review status from its (optional) shared card and the current instant. No card → the
// note is not enrolled and the sheet offers "Add to review". A paused card is withheld from the due scan.
// An active card due at/before now is due now; otherwise it is scheduled for its future due instant.
export function projectEnrollmentStatus(
  card: ReviewCardRow | undefined,
  now: Date
): NoteReviewEnrollmentStatusDto {
  if (card === undefined) {
    return { status: "not_enrolled" };
  }
  if (card.status === "paused") {
    return { status: "paused" };
  }
  if (card.dueAt.getTime() <= now.getTime()) {
    return { status: "due" };
  }
  return { status: "scheduled", nextReviewAt: card.dueAt.toISOString() };
}

// The single current-note prompt entry id for a note, if one exists (#658). At most one can exist — the
// partial unique index enforces it — so this reads the one row that makes the note→prompt relationship.
async function findCurrentNotePromptId(
  reader: Reader,
  noteEntryId: EntryId
): Promise<string | undefined> {
  const rows = await reader
    .select({ entryId: memoryPrompts.entryId })
    .from(memoryPrompts)
    .where(
      and(eq(memoryPrompts.noteEntryId, noteEntryId), eq(memoryPrompts.revealKind, "current_note"))
    )
    .limit(1);

  return rows[0]?.entryId;
}

// The prompt's shared review card for this user, if one exists. Read through the same handle as the reuse
// decision so status and enrollment stay consistent under the note lock.
async function findCard(
  reader: Reader,
  targetEntryId: string,
  userId: string
): Promise<ReviewCardRow | undefined> {
  const rows = await reader
    .select()
    .from(reviewCards)
    .where(and(eq(reviewCards.targetEntryId, targetEntryId), eq(reviewCards.userId, userId)))
    .limit(1);

  return rows[0];
}

// Read a saved note's current Review status without changing anything (#658). Authorizes the note the same
// way enrollment does (owner + work + anchor; a Mark is not enrollable), then projects the status from its
// current-note prompt's shared card. A note with no current-note prompt, or a prompt with no card, reads as
// `not_enrolled` — the sheet offers "Add to review".
export async function getNoteReviewStatus(
  dependencies: NoteReviewEnrollmentDependencies,
  workEntryId: EntryId,
  noteEntryId: EntryId,
  userId: string
): Promise<NoteReviewOutcome<NoteReviewEnrollmentStatusDto>> {
  const target = await getNoteEnrollmentTarget(dependencies.db, workEntryId, noteEntryId, userId);
  if (target === undefined) {
    return { status: "not_found" };
  }
  if (target.kind !== "note") {
    return { status: "not_enrollable" };
  }

  const promptId = await findCurrentNotePromptId(dependencies.db, noteEntryId);
  const card =
    promptId === undefined ? undefined : await findCard(dependencies.db, promptId, userId);

  return { status: "ok", value: projectEnrollmentStatus(card, dependencies.now()) };
}

// Enroll a saved anchored note into Review (#658): create-or-reuse ONE current-note prompt whose cue is the
// exact anchor snapshot (no answer), link it under the note (`contains`), and seed ONE active shared card at
// the recall retention, due now. Idempotent and retry/double-submit safe — the note's `personal_entries`
// row is locked FOR UPDATE so a concurrent second attempt waits, then reuses the prompt/card the first
// created (at most one of each, guaranteed structurally by the partial unique index). An already-enrolled
// re-submit is a pure no-op that returns the existing status WITHOUT resetting the schedule or touching the
// note's chronology; only a genuine create (prompt and/or card) bumps the note's `updated_at`. No review
// event is ever written. The note's body/anchor/provenance/ownership are never changed.
export async function enrollNoteInReview(
  dependencies: NoteReviewEnrollmentDependencies,
  workEntryId: EntryId,
  noteEntryId: EntryId,
  userId: string
): Promise<NoteReviewOutcome<NoteReviewEnrollmentStatusDto>> {
  const target = await getNoteEnrollmentTarget(dependencies.db, workEntryId, noteEntryId, userId);
  if (target === undefined) {
    return { status: "not_found" };
  }
  if (target.kind !== "note") {
    return { status: "not_enrollable" };
  }

  const value = await enrollNoteWithQuestion(
    dependencies,
    noteEntryId,
    userId,
    target.selectedTextSnapshot
  );
  return { status: "ok", value };
}

// The serialized create-or-reuse enrollment transaction shared by BOTH the work-scoped Reader path (#658)
// and the owner-scoped Notes-home path (#659), so there is exactly one enrollment writer. The caller has
// already authorized the note and resolved the question (anchor snapshot for an anchored note, the
// learner's typed question for a standalone one). It locks the note's `personal_entries` row FOR UPDATE so
// a concurrent/retried enrollment blocks then reuses the prompt/card the first created, creates at most one
// current-note prompt (its cue = the question, no answer) and one active shared card at the recall
// retention due now, writes no review event, and bumps the note's `updated_at` only on a genuine create.
async function enrollNoteWithQuestion(
  dependencies: NoteReviewEnrollmentDependencies,
  noteEntryId: EntryId,
  userId: string,
  question: string
): Promise<NoteReviewEnrollmentStatusDto> {
  const now = dependencies.now();

  return dependencies.db.transaction(async (tx) => {
    // Serialize concurrent/retried enrollments of THIS note so the reuse-or-create decision is atomic: a
    // second attempt blocks here, then finds the prompt/card the first created and reuses them.
    await tx
      .select({ entryId: personalEntries.entryId })
      .from(personalEntries)
      .where(eq(personalEntries.entryId, noteEntryId))
      .for("update");

    let changed = false;
    let promptId = await findCurrentNotePromptId(tx, noteEntryId);
    if (promptId === undefined) {
      promptId = dependencies.createId();
      await tx.insert(entries).values({ id: promptId, type: "memory_prompt" });
      await tx.insert(memoryPrompts).values({
        entryId: promptId,
        noteEntryId,
        cueDoc: createTextDocument(question),
        cueText: question,
        answerDoc: null,
        answerText: null,
        lifecycle: "ready",
        revealKind: "current_note",
        chunkId: null,
        createdAt: now
      });
      await tx.insert(entryLinks).values({
        fromEntryId: noteEntryId,
        toEntryId: promptId,
        type: "contains"
      });
      changed = true;
    }

    let card = await findCard(tx, promptId, userId);
    if (card === undefined) {
      await seedReviewCard(tx, {
        targetEntryId: promptId,
        userId,
        requestedRetention: RECALL_REQUEST_RETENTION,
        now
      });
      card = await findCard(tx, promptId, userId);
      changed = true;
    }

    // Only a genuine enrollment change touches the note's chronology — an already-active/paused re-submit
    // returns the existing state without resetting the schedule or bumping `updated_at`.
    if (changed) {
      await tx
        .update(personalEntries)
        .set({ updatedAt: now })
        .where(eq(personalEntries.entryId, noteEntryId));
    }

    return projectEnrollmentStatus(card, now);
  });
}

// The outcome of an owner-scoped enrollment (#659): the shared `ok`/`not_found`/`not_enrollable`, plus
// `question_required` — a standalone (unanchored) note carries no source to reuse as the question, so the
// learner must supply one; the route maps this to a 400.
export type EnrollNoteForOwnerOutcome =
  | NoteReviewOutcome<NoteReviewEnrollmentStatusDto>
  | Readonly<{ status: "question_required" }>;

// Read any owned note's Review status (#659), owner-scoped so a standalone note reads too. Authorizes by
// owner alone (not work + anchor), then projects the status from the note's current-note prompt's shared
// card. A Mark is never a retrieval target; a note with no current-note prompt/card reads as `not_enrolled`.
export async function getNoteReviewStatusForOwner(
  dependencies: NoteReviewEnrollmentDependencies,
  noteEntryId: EntryId,
  userId: string
): Promise<NoteReviewOutcome<NoteReviewEnrollmentStatusDto>> {
  const note = await getNoteForOwner(dependencies.db, noteEntryId, userId);
  if (note === undefined) {
    return { status: "not_found" };
  }
  if (note.kind !== "note") {
    return { status: "not_enrollable" };
  }

  const promptId = await findCurrentNotePromptId(dependencies.db, noteEntryId);
  const card =
    promptId === undefined ? undefined : await findCard(dependencies.db, promptId, userId);

  return { status: "ok", value: projectEnrollmentStatus(card, dependencies.now()) };
}

// Enroll any owned note into Review from the Notes home (#659). Owner-scoped, so a standalone note enrolls
// too. The question is #658's exact source for an anchored note (its anchor snapshot, ignoring any supplied
// text) and the learner's typed question for a standalone note; a standalone note with no supplied,
// non-blank question is `question_required`. A Mark is `not_enrollable`. Delegates to the SAME serialized
// enrollment command as the Reader path, so it is idempotent and retry/double-submit safe.
export async function enrollNoteInReviewForOwner(
  dependencies: NoteReviewEnrollmentDependencies,
  noteEntryId: EntryId,
  userId: string,
  requestedQuestion: string | undefined
): Promise<EnrollNoteForOwnerOutcome> {
  const note = await getNoteForOwner(dependencies.db, noteEntryId, userId);
  if (note === undefined) {
    return { status: "not_found" };
  }
  if (note.kind !== "note") {
    return { status: "not_enrollable" };
  }

  const question =
    note.anchor !== null ? note.anchor.selectedTextSnapshot : requestedQuestion?.trim();
  if (question === undefined || question.length === 0) {
    return { status: "question_required" };
  }

  const value = await enrollNoteWithQuestion(dependencies, noteEntryId, userId, question);
  return { status: "ok", value };
}
