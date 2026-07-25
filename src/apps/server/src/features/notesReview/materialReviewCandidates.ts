import type {
  MaterialReviewCandidateDto,
  NearMaterialReviewCandidateDto
} from "@whetstone/contracts";
import { describeNearMatchDifferences, projectNearMatch } from "@whetstone/document";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { memoryPrompts, noteAnchors, reviewCards } from "../../db/schema.js";
import type { NearMatchNote } from "../notes/noteNearMatchQuery.js";
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

// The shared factual evidence both the exact and near review candidates carry (#712, #714): how many review
// cards each note already owns, and the note's anchor selected-text snapshot when it is anchored to a Work.
// Loaded in two batched owner-safe queries, so enrichment is O(1) round trips regardless of how many
// candidates matched. Presenting factual evidence, never a "duplicate" verdict.
type CandidateEvidence = Readonly<{
  anchorContexts: Map<string, string>;
  cardCounts: Map<string, number>;
}>;

async function loadCandidateEvidence(
  reader: Reader,
  userId: string,
  noteIds: ReadonlyArray<string>
): Promise<CandidateEvidence> {
  const cardRows = await reader
    .select({
      cardCount: sql<number>`count(${reviewCards.targetEntryId})::int`,
      noteEntryId: memoryPrompts.noteEntryId
    })
    .from(memoryPrompts)
    .innerJoin(
      reviewCards,
      and(eq(reviewCards.targetEntryId, memoryPrompts.entryId), eq(reviewCards.userId, userId))
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

  return { anchorContexts, cardCounts };
}

// Enrich each exact-material candidate note (#711) into the review DTO the learner decides over (#712):
// its short answer excerpt, how many review cards it already owns, and the source context it was captured
// from (its anchor's selected text) when it is anchored to a Work, else null. The candidates are returned
// in the SAME order `findExactMaterialNotes` produced (creation then id) — never reordered or preselected by
// recency, source, or card count; presenting factual evidence, not a "duplicate" verdict.
export async function loadMaterialReviewCandidates(
  reader: Reader,
  userId: string,
  notes: ReadonlyArray<ExactMaterialNote>
): Promise<MaterialReviewCandidateDto[]> {
  if (notes.length === 0) {
    return [];
  }
  const evidence = await loadCandidateEvidence(
    reader,
    userId,
    notes.map((note) => note.noteEntryId)
  );

  return notes.map((note) => ({
    answerExcerpt: buildAnswerExcerpt(note.bodyText),
    cardCount: evidence.cardCounts.get(note.noteEntryId) ?? 0,
    noteId: note.noteEntryId,
    sourceContext: evidence.anchorContexts.get(note.noteEntryId) ?? null
  }));
}

// Enrich each high-precision NEAR-match candidate note (#713) into the "Possible duplicate" review DTO the
// learner compares (#714): the same factual evidence as an exact candidate PLUS the concrete word
// `differences` between the candidate's stored material and the drafted Answer. The candidates keep the
// score-order `findNearMatchNotes` produced — never reordered by anything a learner sees — and the fuzzy
// score is never exposed. `answerDoc` is the drafted Answer; its case-sensitive relaxed key is the `after`
// side of every difference, each candidate's stored key the `before` side.
export async function loadNearMaterialReviewCandidates(
  reader: Reader,
  userId: string,
  answerDoc: unknown,
  near: ReadonlyArray<NearMatchNote>
): Promise<NearMaterialReviewCandidateDto[]> {
  if (near.length === 0) {
    return [];
  }
  const target = projectNearMatch(answerDoc);
  /* v8 ignore next 2 -- near is non-empty only when the draft projected to a supported near target, so the
     same deterministic projection re-derives it here; a null target with near candidates is unreachable. */
  const targetKey = target === null ? "" : target.caseSensitiveKey;
  const evidence = await loadCandidateEvidence(
    reader,
    userId,
    near.map((note) => note.noteEntryId)
  );

  return near.map((note) => ({
    answerExcerpt: buildAnswerExcerpt(note.bodyText),
    cardCount: evidence.cardCounts.get(note.noteEntryId) ?? 0,
    differences: describeNearMatchDifferences(note.caseSensitiveKey, targetKey),
    noteId: note.noteEntryId,
    sourceContext: evidence.anchorContexts.get(note.noteEntryId) ?? null
  }));
}
