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
import { getNoteEnrollmentTarget } from "../notes/noteQueries.js";
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

  const question = target.selectedTextSnapshot;
  const now = dependencies.now();

  const value = await dependencies.db.transaction(async (tx) => {
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

  return { status: "ok", value };
}
