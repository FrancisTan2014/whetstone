import type { MaterialReviewCandidateDto } from "@whetstone/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts, noteAnchors, reviewCards } from "../../db/schema.js";
import type { ExactMaterialNote } from "../notes/noteQueries.js";

// A reader satisfied by both the top-level client and an open transaction, so candidate enrichment composes
// inside the save/decision transaction (the authoritative recheck) as well as the advisory query.
type Reader = Pick<DbClient, "select">;

// The longest readable projection of a candidate note's body shown as evidence. A learner recognizes their
// own material from the opening; the full note is one click away in its Cards view. Kept short so the review
// list stays scannable on a narrow screen.
const ANSWER_EXCERPT_MAX = 200;

// A short single-line readable projection of a candidate note's body — collapse internal whitespace and
// truncate with an ellipsis. Derived here from the note's own server-stored `bodyText`, never trusted from
// a client: this projection is evidence, not editable content.
export function buildAnswerExcerpt(bodyText: string): string {
  const collapsed = bodyText.replace(/\s+/g, " ").trim();
  if (collapsed.length <= ANSWER_EXCERPT_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, ANSWER_EXCERPT_MAX).trimEnd()}…`;
}

// Enrich each exact-material candidate note (#711) into the review DTO the learner decides over (#712):
// its short answer excerpt, how many review cards it already owns, and the source context it was captured
// from (its anchor's selected text) when it is anchored to a Work, else null. The candidates are returned
// in the SAME order `findExactMaterialNotes` produced (creation then id) — never reordered or preselected by
// recency, source, or card count; presenting factual evidence, not a "duplicate" verdict. Card counts and
// anchors are loaded in two batched owner-safe queries, so enrichment is O(1) round trips regardless of how
// many candidates matched.
export async function loadMaterialReviewCandidates(
  reader: Reader,
  userId: string,
  notes: ReadonlyArray<ExactMaterialNote>
): Promise<MaterialReviewCandidateDto[]> {
  if (notes.length === 0) {
    return [];
  }
  const noteIds = notes.map((note) => note.noteEntryId);

  const cardRows = await reader
    .select({
      cardCount: sql<number>`count(${reviewCards.targetEntryId})::int`,
      noteEntryId: memoryPrompts.noteEntryId
    })
    .from(memoryPrompts)
    .innerJoin(
      reviewCards,
      and(
        eq(reviewCards.targetEntryId, memoryPrompts.entryId),
        eq(reviewCards.userId, userId)
      )
    )
    .where(inArray(memoryPrompts.noteEntryId, noteIds))
    .groupBy(memoryPrompts.noteEntryId);
  const cardCounts = new Map(cardRows.map((row) => [row.noteEntryId, row.cardCount]));

  const anchorRows = await reader
    .select({
      noteEntryId: noteAnchors.noteEntryId,
      selectedText: noteAnchors.selectedText
    })
    .from(noteAnchors)
    .where(inArray(noteAnchors.noteEntryId, noteIds));
  const anchorContexts = new Map(anchorRows.map((row) => [row.noteEntryId, row.selectedText]));

  return notes.map((note) => ({
    answerExcerpt: buildAnswerExcerpt(note.bodyText),
    cardCount: cardCounts.get(note.noteEntryId) ?? 0,
    noteId: note.noteEntryId,
    sourceContext: anchorContexts.get(note.noteEntryId) ?? null
  }));
}
