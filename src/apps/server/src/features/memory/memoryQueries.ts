import type {
  MemoryDepositDto,
  MemoryNoteDto,
  MemoryPromptCardDto,
  MemoryPromptDto
} from "@whetstone/contracts";
import type { ReviewState } from "@whetstone/domain";
import { and, asc, desc, eq, inArray, isNotNull, lte, or, ilike } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entryLinks, memoryNotes, memoryPrompts, personalEntries } from "../../db/schema.js";

// One persisted memory-note / memory-prompt row, as selected from its table.
export type MemoryNoteRow = typeof memoryNotes.$inferSelect;
export type MemoryPromptRow = typeof memoryPrompts.$inferSelect;

// A scheduled prompt carries a full inlined FSRS card (all columns non-null) and a revealable answer; a
// draft carries neither. This narrows the row to the scheduled shape so the review-state reconstruction
// and the card projection are total functions.
type ScheduledPromptRow = MemoryPromptRow &
  Readonly<{
    answerText: string;
    stability: number;
    difficulty: number;
    elapsedDays: number;
    scheduledDays: number;
    learningSteps: number;
    reps: number;
    lapses: number;
    state: NonNullable<MemoryPromptRow["state"]>;
    dueAt: Date;
  }>;

// True for a card-bearing (scheduled) prompt. The store writes a full FSRS card together with the
// `scheduled` lifecycle and never one without the other, so the lifecycle discriminant alone identifies
// the card-bearing shape — the same construction invariant `scheduledPromptReviewState` relies on. This
// keeps the guard a single, always-meaningful check (no structurally-unreachable null probes on columns
// that a scheduled row can never actually be missing).
function isScheduledRow(row: MemoryPromptRow): row is ScheduledPromptRow {
  return row.lifecycle === "scheduled";
}

// Reconstruct the domain ReviewState from a scheduled prompt row (timestamps -> ISO; null last-reviewed
// preserved), so a recorded review can be scheduled by `@whetstone/domain`.
export function promptReviewState(row: ScheduledPromptRow): ReviewState {
  return {
    due: row.dueAt.toISOString(),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReviewedAt: row.lastReviewedAt === null ? null : row.lastReviewedAt.toISOString()
  };
}

// Map a ReviewState onto the prompt's FSRS columns (ISO -> Date) for insert/update. A scheduled prompt
// always writes these together with `lifecycle: "scheduled"`.
export function promptReviewColumns(state: ReviewState): Pick<
  MemoryPromptRow,
  | "dueAt"
  | "stability"
  | "difficulty"
  | "elapsedDays"
  | "scheduledDays"
  | "learningSteps"
  | "reps"
  | "lapses"
  | "state"
  | "lastReviewedAt"
> {
  return {
    dueAt: new Date(state.due),
    stability: state.stability,
    difficulty: state.difficulty,
    elapsedDays: state.elapsedDays,
    scheduledDays: state.scheduledDays,
    learningSteps: state.learningSteps,
    reps: state.reps,
    lapses: state.lapses,
    state: state.state,
    lastReviewedAt: state.lastReviewedAt === null ? null : new Date(state.lastReviewedAt)
  };
}

// The review state a prompt row carries, or null for a draft.
export function promptReviewStateOrNull(row: MemoryPromptRow): ReviewState | null {
  return isScheduledRow(row) ? promptReviewState(row) : null;
}

// The review state of a prompt the caller has ALREADY established is scheduled — e.g. a row from a
// `lifecycle = 'scheduled'` query, or a freshly built schedulable prompt. The scheduled invariant (all
// FSRS columns present) is guaranteed by the write path and the query filter, so this narrows without a
// runtime branch; use `promptReviewStateOrNull` when the lifecycle is not yet known.
export function scheduledPromptReviewState(row: MemoryPromptRow): ReviewState {
  return promptReviewState(row as ScheduledPromptRow);
}

export function toMemoryPromptDto(row: MemoryPromptRow): MemoryPromptDto {
  return {
    promptId: row.entryId,
    noteId: row.noteEntryId,
    lifecycle: row.lifecycle,
    cueText: row.cueText,
    answerText: row.answerText,
    chunkId: row.chunkId,
    review: promptReviewStateOrNull(row)
  };
}

// A scheduled prompt as the review surface shows it — a card with a revealable answer and FSRS state.
// Only scheduled rows map to a card; a draft has no card face.
export function toMemoryPromptCardDto(row: ScheduledPromptRow): MemoryPromptCardDto {
  return {
    promptId: row.entryId,
    noteId: row.noteEntryId,
    cueText: row.cueText,
    // A scheduled prompt always carries a non-null answer (the scheduled invariant), reflected in the
    // narrowed row type, so the projection needs no fallback.
    answerText: row.answerText,
    chunkId: row.chunkId,
    review: promptReviewState(row)
  };
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
// review or fetch. Returns the raw row so a caller can reconstruct its review state.
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

// One prompt scoped to its owner as a DTO (the read counterpart of `get_memory_prompt`).
export async function getMemoryPromptForUser(
  db: DbClient,
  promptId: string,
  userId: string
): Promise<MemoryPromptDto | undefined> {
  const row = await getPromptRowForUser(db, promptId, userId);
  return row === undefined ? undefined : toMemoryPromptDto(row);
}

// The user's scheduled prompt linked to a given chunk, if any (newest first). Used by the practice
// session to find-or-create the prompt to schedule for a practised chunk. Only scheduled prompts
// match — a draft has no card to advance.
export async function getScheduledPromptByChunkForUser(
  db: DbClient,
  userId: string,
  chunkId: string
): Promise<MemoryPromptRow | undefined> {
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        eq(memoryPrompts.chunkId, chunkId),
        eq(memoryPrompts.lifecycle, "scheduled")
      )
    )
    .orderBy(desc(memoryPrompts.createdAt), asc(memoryPrompts.entryId))
    .limit(1);

  return rows[0]?.prompt;
}

// The user's most-recent prompt with this exact cue text, if any. Used to dedupe LLM-supplied prompts
// (e.g. the bilingual coach's pushed English target, #270) that have no chunk FK to match on.
export async function getPromptByCueTextForUser(
  db: DbClient,
  userId: string,
  cueText: string
): Promise<MemoryPromptRow | undefined> {
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(and(eq(personalEntries.userId, userId), eq(memoryPrompts.cueText, cueText)))
    .orderBy(desc(memoryPrompts.createdAt), asc(memoryPrompts.entryId))
    .limit(1);

  return rows[0]?.prompt;
}

// The user's scheduled prompts due at `now` (due_at <= now), soonest-due first, capped at `limit`.
export async function listDuePromptCards(
  db: DbClient,
  userId: string,
  now: Date,
  limit: number
): Promise<ReadonlyArray<MemoryPromptCardDto>> {
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        eq(memoryPrompts.lifecycle, "scheduled"),
        lte(memoryPrompts.dueAt, now)
      )
    )
    .orderBy(asc(memoryPrompts.dueAt), asc(memoryPrompts.entryId))
    .limit(limit);

  return rows
    .map((joined) => joined.prompt)
    .filter(isScheduledRow)
    .map(toMemoryPromptCardDto);
}

// LIKE metacharacters are escaped so a query is matched literally; PostgreSQL ILIKE treats backslash as
// the escape character by default.
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

// The user's prompts whose cue or answer text contains `query` (case-insensitive), newest first.
export async function searchMemoryPrompts(
  db: DbClient,
  userId: string,
  query: string
): Promise<ReadonlyArray<MemoryPromptDto>> {
  const pattern = `%${escapeLike(query)}%`;
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        or(ilike(memoryPrompts.cueText, pattern), ilike(memoryPrompts.answerText, pattern))
      )
    )
    .orderBy(desc(memoryPrompts.createdAt), asc(memoryPrompts.entryId));

  return rows.map((joined) => toMemoryPromptDto(joined.prompt));
}

// Group the user's scheduled prompt review states by the chunk each prompt is linked to. Shared by
// Cases mastery, the Map, the learner model, and the nudge ranking (each restricts to a chunk set or
// takes all linked chunks), so the ownership join + draft exclusion live in one place.
async function chunkReviewStates(
  db: DbClient,
  userId: string,
  restrictChunkIds: ReadonlyArray<string> | null
): Promise<Map<string, ReviewState[]>> {
  const chunkFilter =
    restrictChunkIds === null
      ? isNotNull(memoryPrompts.chunkId)
      : inArray(memoryPrompts.chunkId, [...restrictChunkIds]);
  const rows = await db
    .select({ prompt: memoryPrompts })
    .from(memoryPrompts)
    .innerJoin(personalEntries, eq(memoryPrompts.noteEntryId, personalEntries.entryId))
    .where(
      and(eq(personalEntries.userId, userId), eq(memoryPrompts.lifecycle, "scheduled"), chunkFilter)
    );

  const byChunk = new Map<string, ReviewState[]>();
  for (const { prompt } of rows) {
    // The query restricts to scheduled prompts with a non-null chunk, so both are guaranteed here (the
    // same invariant `scheduledPromptReviewState` trusts); group each chunk's review states together.
    const chunkId = prompt.chunkId as string;
    const states = byChunk.get(chunkId) ?? [];
    states.push(scheduledPromptReviewState(prompt));
    byChunk.set(chunkId, states);
  }
  return byChunk;
}

// The user's scheduled prompt review states for a given set of chunk ids, grouped by chunk. An empty
// set yields an empty map without a query.
export async function reviewStatesByChunkIds(
  db: DbClient,
  userId: string,
  chunkIds: ReadonlyArray<string>
): Promise<Map<string, ReviewState[]>> {
  if (chunkIds.length === 0) {
    return new Map();
  }
  return chunkReviewStates(db, userId, chunkIds);
}

// The user's scheduled prompt review states for every chunk-linked prompt, grouped by chunk.
export async function allChunkReviewStates(
  db: DbClient,
  userId: string
): Promise<Map<string, ReviewState[]>> {
  return chunkReviewStates(db, userId, null);
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

// Assemble a full deposit DTO (the note plus every prompt under it) from persisted rows.
export function toMemoryDepositDto(
  note: MemoryNoteRow,
  derivedFromEntryId: string | null,
  prompts: ReadonlyArray<MemoryPromptRow>
): MemoryDepositDto {
  return {
    note: toMemoryNoteDto(note, derivedFromEntryId),
    prompts: prompts.map(toMemoryPromptDto)
  };
}

export type { MemoryDepositDto, MemoryNoteDto, MemoryPromptCardDto, MemoryPromptDto };
