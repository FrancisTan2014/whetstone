import type {
  MemoryDepositDto,
  MemoryNoteDetailDto,
  MemoryNoteDto,
  MemoryNoteSummaryDto,
  MemoryPromptCardDto,
  MemoryPromptDto
} from "@whetstone/contracts";
import type { ReviewState } from "@whetstone/domain";
import { localDayBoundary } from "@whetstone/domain";
import { and, asc, desc, eq, inArray, lte, or, ilike } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  entryLinks,
  memoryNotes,
  memoryPrompts,
  personalEntries,
  reviewCards
} from "../../db/schema.js";
import { reviewStateFromCard, type ReviewCardRow } from "../review/reviewCardQueries.js";

// One persisted memory-note / memory-prompt row, as selected from its table. A prompt row no longer holds
// any scheduling state — the FSRS card lives in the shared `review_cards` substrate (#617).
export type MemoryNoteRow = typeof memoryNotes.$inferSelect;
export type MemoryPromptRow = typeof memoryPrompts.$inferSelect;

// A ready prompt row narrowed so its answer is present. `ready` means "revealable answer" by construction
// (the domain lifecycle gate), so a ready row's `answerText` is never null — this makes the card
// projection a total function without a runtime fallback.
type ReadyPromptRow = MemoryPromptRow & Readonly<{ answerText: string }>;

// True for a ready prompt row. The lifecycle discriminant alone identifies the answer-bearing shape (the
// domain guarantees `ready ⇒ meaningful answer`), so this is a single always-meaningful check.
function isReadyRow(row: MemoryPromptRow): row is ReadyPromptRow {
  return row.lifecycle === "ready";
}

// Project a prompt row plus its review state (from the shared card, or null when the prompt is not
// enrolled) into the full prompt DTO.
export function toMemoryPromptDto(
  row: MemoryPromptRow,
  review: ReviewState | null
): MemoryPromptDto {
  return {
    promptId: row.entryId,
    noteId: row.noteEntryId,
    lifecycle: row.lifecycle,
    cueText: row.cueText,
    answerText: row.answerText,
    chunkId: row.chunkId,
    review
  };
}

// A ready, enrolled prompt as the review surface shows it — a card with a revealable answer and the FSRS
// state read from its shared review card. Only a ready row with an active card reaches here.
export function toMemoryPromptCardDto(
  row: ReadyPromptRow,
  card: ReviewCardRow
): MemoryPromptCardDto {
  return {
    promptId: row.entryId,
    noteId: row.noteEntryId,
    cueText: row.cueText,
    answerText: row.answerText,
    chunkId: row.chunkId,
    review: reviewStateFromCard(card)
  };
}

// Map a prompt row and its optional shared card into the prompt DTO (card -> review state, or null).
function promptRowWithCardToDto(row: MemoryPromptRow, card: ReviewCardRow | null): MemoryPromptDto {
  return toMemoryPromptDto(row, card === null ? null : reviewStateFromCard(card));
}

export function toMemoryNoteDto(
  row: MemoryNoteRow,
  derivedFromEntryId: string | null
): MemoryNoteDto {
  return {
    noteId: row.entryId,
    captureSource: row.captureSource,
    bodyText: row.bodyText,
    derivedFromEntryId
  };
}

// One prompt row scoped to its owner (the owning note's `personal_entries` user), used to authorize a
// review or fetch. Returns the raw row so a caller can pair it with its shared review card.
export async function getPromptRowForUser(
  db: DbClient,
  promptId: string,
  userId: string
): Promise<MemoryPromptRow | undefined> {
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(and(eq(memoryPrompts.entryId, promptId), eq(personalEntries.userId, userId)))
    .limit(1);

  return rows[0]?.prompt;
}

// One prompt scoped to its owner as a DTO (the read counterpart of `get_memory_prompt`), pairing the
// prompt with its shared review card (null when the prompt is an unenrolled draft).
export async function getMemoryPromptForUser(
  db: DbClient,
  promptId: string,
  userId: string
): Promise<MemoryPromptDto | undefined> {
  const rows = await db
    .select({ prompt: memoryPrompts, card: reviewCards })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .leftJoin(reviewCards, eq(reviewCards.targetEntryId, memoryPrompts.entryId))
    .where(and(eq(memoryPrompts.entryId, promptId), eq(personalEntries.userId, userId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? undefined : promptRowWithCardToDto(row.prompt, row.card);
}

// The user's enrolled prompts whose active card is due at `now` (`due_at` <= now), soonest-due first,
// capped at `limit`. The due schedule is read from the shared `review_cards` substrate; the prompt
// supplies the reviewable content.
export async function listDuePromptCards(
  db: DbClient,
  userId: string,
  now: Date,
  limit: number
): Promise<ReadonlyArray<MemoryPromptCardDto>> {
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
    .limit(limit);

  return rows
    .filter((row): row is { prompt: ReadyPromptRow; card: ReviewCardRow } => isReadyRow(row.prompt))
    .map((row) => toMemoryPromptCardDto(row.prompt, row.card));
}

// The learner's Memory-review routine as Today's board reads it (#610): one grouped summary over the
// user's enrolled prompts' active review cards — how many are due now (`due_at` <= now), how many are
// overdue (due before the local day started, #606), and the earliest due instant (null when nothing is
// due). Paused/snoozed prompts are simply prompts whose card is not yet due, so they fall out naturally.
// A single scoped read of the active cards' due instants; the counts are folded in memory so the whole
// routine costs one round-trip.
export async function loadMemoryRoutineSummary(
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

// LIKE metacharacters are escaped so a query is matched literally; PostgreSQL ILIKE treats backslash as
// the escape character by default.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// The user's prompts whose cue or answer text contains `query` (case-insensitive), newest first, each
// paired with its shared review card (null for a draft).
export async function searchMemoryPrompts(
  db: DbClient,
  userId: string,
  query: string
): Promise<ReadonlyArray<MemoryPromptDto>> {
  const pattern = `%${escapeLike(query)}%`;
  const rows = await db
    .select({ prompt: memoryPrompts, card: reviewCards })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .leftJoin(reviewCards, eq(reviewCards.targetEntryId, memoryPrompts.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        or(ilike(memoryPrompts.cueText, pattern), ilike(memoryPrompts.answerText, pattern))
      )
    )
    .orderBy(desc(memoryPrompts.createdAt), asc(memoryPrompts.entryId));

  return rows.map((row) => promptRowWithCardToDto(row.prompt, row.card));
}

// The `derived_from` provenance target of a note (the source Entry it was made durable from), or null.
export async function noteProvenanceEntryId(
  db: DbClient,
  noteEntryId: string
): Promise<string | null> {
  const rows = await db
    .select({ toEntryId: entryLinks.toEntryId })
    .from(entryLinks)
    .where(and(eq(entryLinks.fromEntryId, noteEntryId), eq(entryLinks.type, "derived_from")))
    .limit(1);
  return rows[0]?.toEntryId ?? null;
}

// One memory note scoped to its owner (the note's `personal_entries` user), used to authorize an
// edit/detail/delete. Returns the raw note row, or undefined when it does not exist or is not owned.
export async function getMemoryNoteRowForUser(
  db: DbClient,
  userId: string,
  noteId: string
): Promise<MemoryNoteRow | undefined> {
  const rows = await db
    .select({ note: memoryNotes })
    .from(memoryNotes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, memoryNotes.entryId))
    .where(and(eq(memoryNotes.entryId, noteId), eq(personalEntries.userId, userId)))
    .limit(1);
  return rows[0]?.note;
}

// A prompt paired with its shared review card (null when the prompt is an unenrolled draft), used to roll
// a note's prompts up for the summary and to project detail.
type PromptWithCard = Readonly<{ prompt: MemoryPromptRow; card: ReviewCardRow | null }>;

// Roll a note's prompts up into the jargon-free summary the Memory list/search row shows: total prompts,
// how many are drafts vs scheduled (enrolled with a card), how many are due now, and the soonest next-due
// (null when the note has no scheduled prompt). The scheduling facts read from each prompt's shared card.
function summarizeNote(
  note: MemoryNoteRow,
  prompts: ReadonlyArray<PromptWithCard>,
  now: Date
): MemoryNoteSummaryDto {
  let draftCount = 0;
  let scheduledCount = 0;
  let dueCount = 0;
  let nextDueAt: Date | null = null;
  for (const { card } of prompts) {
    if (card === null) {
      draftCount += 1;
      continue;
    }
    scheduledCount += 1;
    if (card.dueAt <= now) {
      dueCount += 1;
    }
    if (nextDueAt === null || card.dueAt < nextDueAt) {
      nextDueAt = card.dueAt;
    }
  }
  return {
    noteId: note.entryId,
    captureSource: note.captureSource,
    bodyText: note.bodyText,
    promptCount: prompts.length,
    draftCount,
    scheduledCount,
    dueCount,
    nextDueAt: nextDueAt === null ? null : nextDueAt.toISOString()
  };
}

// The owner's memory notes as summaries, newest first, restricted to `restrictNoteIds` when given (an
// empty restriction yields no rows without a query). Notes and their prompts (each with its shared card)
// are loaded once each and aggregated in memory, so the summary counts derive from a single consistent
// read.
async function loadNoteSummaries(
  db: DbClient,
  userId: string,
  restrictNoteIds: ReadonlyArray<string> | null,
  now: Date
): Promise<ReadonlyArray<MemoryNoteSummaryDto>> {
  if (restrictNoteIds !== null && restrictNoteIds.length === 0) {
    return [];
  }
  const ownerFilter = eq(personalEntries.userId, userId);
  const where =
    restrictNoteIds === null
      ? ownerFilter
      : and(ownerFilter, inArray(memoryNotes.entryId, [...restrictNoteIds]));
  const noteRows = await db
    .select({ note: memoryNotes, occurredAt: personalEntries.occurredAt })
    .from(memoryNotes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, memoryNotes.entryId))
    .where(where)
    .orderBy(desc(personalEntries.occurredAt), asc(memoryNotes.entryId));
  if (noteRows.length === 0) {
    return [];
  }
  const noteIds = noteRows.map((row) => row.note.entryId);
  const promptRows = await db
    .select({ prompt: memoryPrompts, card: reviewCards })
    .from(memoryPrompts)
    .leftJoin(reviewCards, eq(reviewCards.targetEntryId, memoryPrompts.entryId))
    .where(inArray(memoryPrompts.noteEntryId, noteIds));
  const byNote = new Map<string, PromptWithCard[]>();
  for (const { prompt, card } of promptRows) {
    const bucket = byNote.get(prompt.noteEntryId) ?? [];
    bucket.push({ prompt, card });
    byNote.set(prompt.noteEntryId, bucket);
  }
  return noteRows.map((row) => summarizeNote(row.note, byNote.get(row.note.entryId) ?? [], now));
}

// Every memory note the user owns, as list-row summaries (newest first) — learner-created notes AND
// deposits from practice/tools alike, since all are the same first-class note Entry.
export async function listMemoryNotes(
  db: DbClient,
  userId: string,
  now: Date
): Promise<ReadonlyArray<MemoryNoteSummaryDto>> {
  return loadNoteSummaries(db, userId, null, now);
}

// The user's memory notes whose body OR any of whose prompt cue/answer text contains `query`
// (case-insensitive), as summaries. Matching a prompt surfaces its owning note once — the search is
// note-centric, so a note never appears twice because two of its prompts matched.
export async function searchMemoryNotes(
  db: DbClient,
  userId: string,
  query: string,
  now: Date
): Promise<ReadonlyArray<MemoryNoteSummaryDto>> {
  const pattern = `%${escapeLike(query)}%`;
  const bodyMatches = await db
    .select({ entryId: memoryNotes.entryId })
    .from(memoryNotes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, memoryNotes.entryId))
    .where(and(eq(personalEntries.userId, userId), ilike(memoryNotes.bodyText, pattern)));
  const promptMatches = await db
    .select({ noteEntryId: memoryPrompts.noteEntryId })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(personalEntries.entryId, memoryPrompts.noteEntryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        or(ilike(memoryPrompts.cueText, pattern), ilike(memoryPrompts.answerText, pattern))
      )
    );
  const matchedIds = new Set<string>();
  for (const row of bodyMatches) {
    matchedIds.add(row.entryId);
  }
  for (const row of promptMatches) {
    matchedIds.add(row.noteEntryId);
  }
  return loadNoteSummaries(db, userId, [...matchedIds], now);
}

// The full detail of one memory note the user owns: the note (with its provenance target) and every
// prompt under it (draft or scheduled, each with its shared card), oldest first. Undefined when the note
// does not exist or is not owned by the user.
export async function getMemoryNoteDetail(
  db: DbClient,
  userId: string,
  noteId: string
): Promise<MemoryNoteDetailDto | undefined> {
  const noteRow = await getMemoryNoteRowForUser(db, userId, noteId);
  if (noteRow === undefined) {
    return undefined;
  }
  const derivedFromEntryId = await noteProvenanceEntryId(db, noteId);
  const promptRows = await db
    .select({ prompt: memoryPrompts, card: reviewCards })
    .from(memoryPrompts)
    .leftJoin(reviewCards, eq(reviewCards.targetEntryId, memoryPrompts.entryId))
    .where(eq(memoryPrompts.noteEntryId, noteId))
    .orderBy(asc(memoryPrompts.createdAt), asc(memoryPrompts.entryId));
  return {
    note: toMemoryNoteDto(noteRow, derivedFromEntryId),
    prompts: promptRows.map((row) => promptRowWithCardToDto(row.prompt, row.card))
  };
}

// Assemble a full deposit DTO (the note plus every prompt under it) from persisted rows and the review
// states seeded for the ready prompts (keyed by prompt id; absent for a draft).
export function toMemoryDepositDto(
  note: MemoryNoteRow,
  derivedFromEntryId: string | null,
  prompts: ReadonlyArray<MemoryPromptRow>,
  reviews: ReadonlyMap<string, ReviewState>
): MemoryDepositDto {
  return {
    note: toMemoryNoteDto(note, derivedFromEntryId),
    prompts: prompts.map((row) => toMemoryPromptDto(row, reviews.get(row.entryId) ?? null))
  };
}

export type {
  MemoryDepositDto,
  MemoryNoteDetailDto,
  MemoryNoteDto,
  MemoryNoteSummaryDto,
  MemoryPromptCardDto,
  MemoryPromptDto
};
