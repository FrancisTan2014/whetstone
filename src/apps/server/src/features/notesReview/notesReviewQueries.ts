import type { NoteReviewPromptDto, NoteRevealDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { and, asc, eq, lte } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts, notes, personalEntries, reviewCards } from "../../db/schema.js";
import { reviewStateFromCard } from "../review/reviewCardQueries.js";
import { resolveNoteReveal } from "./notesReviewReveal.js";

// The single earliest-due prompt the Notes-owned session presents, or null when nothing is due (#657).
// Scoped to the owner through the note's `personal_entries` facet, restricted to ACTIVE cards due at
// `now` — so paused and cardless prompts never enter selection — and ordered soonest-due first, ties
// broken by prompt id for a deterministic pick. Only the question phase is returned (cue + card state),
// never the answer; the reveal is fetched separately when the learner asks for it.
export async function loadNextDueNotePrompt(
  db: DbClient,
  userId: string,
  now: Date
): Promise<NoteReviewPromptDto | null> {
  const rows = await db
    .select({ prompt: memoryPrompts, card: reviewCards })
    .from(memoryPrompts)
    .innerJoin(
      reviewCards,
      and(
        eq(reviewCards.targetEntryId, memoryPrompts.entryId),
        eq(reviewCards.status, "active"),
        lte(reviewCards.dueAt, now)
      )
    )
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(eq(personalEntries.userId, userId))
    .orderBy(asc(reviewCards.dueAt), asc(memoryPrompts.entryId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    promptId: row.prompt.entryId,
    noteId: row.prompt.noteEntryId,
    cueDoc: row.prompt.cueDoc as DocumentNodeJSON,
    cueText: row.prompt.cueText,
    revealKind: row.prompt.revealKind,
    review: reviewStateFromCard(row.card)
  };
}

// Resolve one prompt's reveal for its owner, or undefined when the prompt is not the caller's, or has no
// ACTIVE card (paused or unenrolled) — those are never revealable, so the route answers 404 (#657). Joins
// the referenced note so a `current_note` reveal reads the live canonical body; the pure resolver picks
// the shape from the persisted discriminant.
export async function loadNotePromptReveal(
  db: DbClient,
  userId: string,
  promptId: string
): Promise<NoteRevealDto | undefined> {
  const rows = await db
    .select({
      revealKind: memoryPrompts.revealKind,
      answerDoc: memoryPrompts.answerDoc,
      answerText: memoryPrompts.answerText,
      noteBodyDoc: notes.bodyDoc,
      noteBodyText: notes.bodyText
    })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .innerJoin(notes, eq(notes.entryId, memoryPrompts.noteEntryId))
    .innerJoin(
      reviewCards,
      and(eq(reviewCards.targetEntryId, memoryPrompts.entryId), eq(reviewCards.status, "active"))
    )
    .where(and(eq(memoryPrompts.entryId, promptId), eq(personalEntries.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  return resolveNoteReveal({
    revealKind: row.revealKind,
    answerDoc: row.answerDoc as DocumentNodeJSON | null,
    answerText: row.answerText,
    noteBodyDoc: row.noteBodyDoc as DocumentNodeJSON,
    noteBodyText: row.noteBodyText as string
  });
}
