import type { NoteDto, NoteOverviewDto, NoteReviewSummaryDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { toEntryId, type CaptureSource, type EntryId, type NoteAnchor } from "@whetstone/domain";
import { and, asc, desc, eq, ilike, inArray, isNull, or } from "drizzle-orm";

import { addressableBlocks } from "../../db/addressableBlocks.js";
import type { DbClient } from "../../db/dbClient.js";
import {
  authors,
  memoryPrompts,
  noteAnchors,
  notes,
  personalEntries,
  readingUnits,
  reviewCards,
  workMeta
} from "../../db/schema.js";

// A block's content plus its position in the work's reading order — the reading unit's order index
// then the block's order index within that unit — so a cross-block span can be checked for a valid
// (non-reversed) start..end ordering (#257).
export type BlockInWork = Readonly<{
  orderIndex: number;
  plaintext: string;
  unitOrderIndex: number;
}>;

// A note may only annotate an active block that belongs to the named work; this single
// lookup both confirms the block exists (and is not soft-deleted) and scopes it to the
// work via the block's own `work_entry_id`. The block is resolved over both substrates
// (legacy mdast `blocks` and PM `doc_blocks`) so a note anchored to a PM-rendered block id
// resolves too (#312). The join to its reading unit yields the unit's order index, so callers
// can compare two blocks' reading-order position.
export async function findBlockInWork(
  db: DbClient,
  workEntryId: EntryId,
  blockEntryId: EntryId
): Promise<BlockInWork | undefined> {
  const addressable = addressableBlocks(db);
  const rows = await db
    .select({
      orderIndex: addressable.orderIndex,
      plaintext: addressable.plaintext,
      unitOrderIndex: readingUnits.orderIndex
    })
    .from(addressable)
    .innerJoin(readingUnits, eq(addressable.readingUnitEntryId, readingUnits.entryId))
    .where(
      and(
        eq(addressable.entryId, blockEntryId),
        eq(addressable.workEntryId, workEntryId),
        isNull(addressable.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];

  return row === undefined
    ? undefined
    : { orderIndex: row.orderIndex, plaintext: row.plaintext, unitOrderIndex: row.unitOrderIndex };
}

// A note row joined to its optional anchor and its owning personal-entry chronology facet. The anchor
// columns are nullable because a note may be unanchored (a manual or Memory note has no source anchor):
// they are all-or-nothing — a `note_anchors` row supplies all four together, or there is no row and all
// four are null. `captureSource` and the `created/occurred/updated` instants come from the unified
// `notes` + `personal_entries` facets every note owns.
type NoteRow = Readonly<{
  blockEntryId: string | null;
  bodyDoc: unknown;
  bodyText: string | null;
  captureSource: CaptureSource;
  contextSnapshot: string | null;
  createdAt: Date;
  endBlockEntryId: string | null;
  endOffset: number | null;
  entryId: string;
  kind: "note" | "mark";
  occurredAt: Date;
  selectedText: string | null;
  startOffset: number | null;
  updatedAt: Date;
}>;

const noteColumns = {
  blockEntryId: noteAnchors.blockEntryId,
  bodyDoc: notes.bodyDoc,
  bodyText: notes.bodyText,
  captureSource: notes.captureSource,
  contextSnapshot: noteAnchors.contextSnapshot,
  createdAt: personalEntries.createdAt,
  endBlockEntryId: noteAnchors.endBlockEntryId,
  endOffset: noteAnchors.endOffset,
  entryId: notes.entryId,
  kind: notes.kind,
  occurredAt: personalEntries.occurredAt,
  selectedText: noteAnchors.selectedText,
  startOffset: noteAnchors.startOffset,
  updatedAt: personalEntries.updatedAt
} as const;

// Build the note's zero-or-one source anchor. `note_anchors` supplies its NOT NULL columns
// (block/end-block/context/selected-text) as an all-or-nothing group, so a null `blockEntryId` means the
// LEFT JOIN found no anchor row and the note is unanchored; the sibling columns are then null too and the
// non-null assertions below hold. Offsets remain independently optional (a whole-block selection has none).
function toNoteAnchor(row: NoteRow): NoteAnchor | null {
  if (row.blockEntryId === null) {
    return null;
  }

  const base = {
    blockEntryId: toEntryId(row.blockEntryId),
    contextSnapshot: row.contextSnapshot as string,
    endBlockEntryId: toEntryId(row.endBlockEntryId as string),
    selectedTextSnapshot: row.selectedText as string
  };

  if (row.startOffset === null || row.endOffset === null) {
    return base;
  }

  return { ...base, endOffset: row.endOffset, startOffset: row.startOffset };
}

function toNoteDto(row: NoteRow): NoteDto {
  return {
    anchor: toNoteAnchor(row),
    blockEntryId: row.blockEntryId === null ? null : toEntryId(row.blockEntryId),
    bodyDoc: row.bodyDoc as DocumentNodeJSON | null,
    bodyText: row.bodyText,
    captureSource: row.captureSource,
    createdAt: row.createdAt.toISOString(),
    entryId: toEntryId(row.entryId),
    kind: row.kind,
    occurredAt: row.occurredAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

// All notes anchored to a block within the work, joined to their anchor. Scoped through
// the block's `work_entry_id` so notes on soft-deleted (unit-detached) blocks remain
// listed. Ordered by note id for a deterministic list; the client groups them by block.
export async function listNotesForWork(
  db: DbClient,
  workEntryId: EntryId,
  userId: string
): Promise<ReadonlyArray<NoteDto>> {
  const addressable = addressableBlocks(db);
  const rows = await db
    .select(noteColumns)
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .innerJoin(addressable, eq(addressable.entryId, noteAnchors.blockEntryId))
    .where(and(eq(addressable.workEntryId, workEntryId), eq(personalEntries.userId, userId)))
    .orderBy(asc(notes.entryId));

  return rows.map(toNoteDto);
}

type NoteOverviewRow = NoteRow &
  Readonly<{
    authorName: string | null;
    workEntryId: string | null;
    workTitle: string | null;
  }>;

// The parts of a review card the Notes home's rolled-up summary needs (#659): its active/paused status and
// its due instant, tagged with the note whose prompt owns it so cards can be grouped per note. The full
// FSRS state is irrelevant to the projection — only "is it due, scheduled, or paused" matters.
type NoteReviewCardRow = Readonly<{
  dueAt: Date;
  noteEntryId: string;
  status: "active" | "paused";
}>;

// Roll a note's zero-or-more review cards into the single Review state its Notes-home row shows (#659),
// with a fixed precedence so several legacy prompts still resolve to one calm state: any active card due
// at/before `now` → `due` with the count of such cards; otherwise the earliest active future card →
// `scheduled` for that instant; otherwise a card exists but only paused → `paused`; otherwise no card →
// `not_enrolled` (the row offers "Add to review"). Pure over the card set + clock so the precedence is
// tested without a database.
export function summarizeNoteReview(
  cards: ReadonlyArray<NoteReviewCardRow>,
  now: Date
): NoteReviewSummaryDto {
  const active = cards.filter((card) => card.status === "active");
  const dueCount = active.filter((card) => card.dueAt.getTime() <= now.getTime()).length;
  if (dueCount > 0) {
    return { status: "due", dueCount };
  }
  if (active.length > 0) {
    const earliest = active.reduce((soonest, card) =>
      card.dueAt.getTime() < soonest.dueAt.getTime() ? card : soonest
    );
    return { status: "scheduled", nextReviewAt: earliest.dueAt.toISOString() };
  }
  if (cards.length > 0) {
    return { status: "paused" };
  }
  return { status: "not_enrolled" };
}

function toNoteOverviewBase(row: NoteOverviewRow): Omit<NoteOverviewDto, "review"> {
  return {
    ...toNoteDto(row),
    authorName: row.authorName,
    workEntryId: row.workEntryId === null ? null : toEntryId(row.workEntryId),
    workTitle: row.workTitle
  };
}

// Every review card belonging to the given notes' prompts, for this user, tagged with the owning note so
// the Notes-home list can roll each note's cards into one summary. A note with no prompt/card contributes
// no row and rolls up as `not_enrolled`. Returns an empty array for an empty id set without a query.
async function listNoteReviewCards(
  db: DbClient,
  noteEntryIds: ReadonlyArray<string>,
  userId: string
): Promise<ReadonlyArray<NoteReviewCardRow>> {
  if (noteEntryIds.length === 0) {
    return [];
  }
  return db
    .select({
      dueAt: reviewCards.dueAt,
      noteEntryId: memoryPrompts.noteEntryId,
      status: reviewCards.status
    })
    .from(memoryPrompts)
    .innerJoin(
      reviewCards,
      and(eq(reviewCards.targetEntryId, memoryPrompts.entryId), eq(reviewCards.userId, userId))
    )
    .where(inArray(memoryPrompts.noteEntryId, [...noteEntryIds]));
}

// Group a flat card list by its owning note so each note gets exactly its own cards for the roll-up.
function groupCardsByNote(
  cards: ReadonlyArray<NoteReviewCardRow>
): ReadonlyMap<string, ReadonlyArray<NoteReviewCardRow>> {
  const byNote = new Map<string, NoteReviewCardRow[]>();
  for (const card of cards) {
    const existing = byNote.get(card.noteEntryId);
    if (existing === undefined) {
      byNote.set(card.noteEntryId, [card]);
    } else {
      existing.push(card);
    }
  }
  return byNote;
}

// Escape the LIKE wildcards (`%`, `_`) and the escape char itself in a user's search text so a query such
// as "50%" matches the literal characters instead of being read as a pattern. The default PostgreSQL LIKE
// escape (`\`) then applies.
function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// The distinct ids of the user's notes matching a note-centric search (#659): a note matches when the
// query text appears in its canonical body, its anchor's selected-text snapshot, ANY of its prompts'
// questions, or ANY of its prompts' learner-authored reveal answers (a preserved legacy custom answer or an
// `expected_response` Success check — both are learner content stored in `answer_text`; a `current_note`
// prompt has none). All four sources are searched in one pass with the prompt/anchor facets LEFT-joined (an
// unanchored or unenrolled note simply has no matching facet); `selectDistinct` collapses a note that
// matches on several prompts to one id. The match is case-insensitive (`ILIKE`) and wildcard-safe.
async function searchNoteIds(
  db: DbClient,
  userId: string,
  query: string
): Promise<ReadonlyArray<string>> {
  const pattern = `%${escapeLikePattern(query)}%`;
  const rows = await db
    .selectDistinct({ entryId: notes.entryId })
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .leftJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .leftJoin(memoryPrompts, eq(memoryPrompts.noteEntryId, notes.entryId))
    .where(
      and(
        eq(personalEntries.userId, userId),
        or(
          ilike(notes.bodyText, pattern),
          ilike(noteAnchors.selectedText, pattern),
          ilike(memoryPrompts.cueText, pattern),
          and(
            inArray(memoryPrompts.revealKind, ["legacy_custom", "expected_response"]),
            ilike(memoryPrompts.answerText, pattern)
          )
        )
      )
    );
  return rows.map((row) => row.entryId);
}

// Optional narrowing for the Notes home (#659): restrict to one Work (anchored notes in that work only),
// and/or a note-centric search. Neither changes the stable recency order.
export type ListNotesOptions = Readonly<{
  search?: string | undefined;
  workEntryId?: EntryId | undefined;
}>;

// Every note the user owns — the single Notes home (#659). One continuous list in stable recency order
// (`updated_at` newest first, note id as the deterministic tie-breaker), each note appearing exactly once
// whether anchored, standalone, imported, or a bodyless Mark. The anchor, its block's work, and the work's
// author are LEFT-joined so an unanchored note is still listed with null work fields. `workEntryId` narrows
// to anchored notes in that one work; a non-blank `search` restricts to notes matching across body, anchor
// snapshot, prompt questions, and legacy answers (a blank query is ignored). Each note carries its rolled-up
// Review summary, joined from its prompt/cards — never persisted on the note.
export async function listNotesForUser(
  db: DbClient,
  userId: string,
  now: Date,
  options: ListNotesOptions = {}
): Promise<ReadonlyArray<NoteOverviewDto>> {
  const search = options.search?.trim();
  let matchingIds: ReadonlyArray<string> | undefined;
  if (search !== undefined && search.length > 0) {
    matchingIds = await searchNoteIds(db, userId, search);
    if (matchingIds.length === 0) {
      return [];
    }
  }

  const addressable = addressableBlocks(db);
  const filters = [eq(personalEntries.userId, userId)];
  if (options.workEntryId !== undefined) {
    filters.push(eq(addressable.workEntryId, options.workEntryId));
  }
  if (matchingIds !== undefined) {
    filters.push(inArray(notes.entryId, [...matchingIds]));
  }

  const rows = await db
    .select({
      ...noteColumns,
      authorName: authors.name,
      workEntryId: addressable.workEntryId,
      workTitle: workMeta.title
    })
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .leftJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .leftJoin(addressable, eq(addressable.entryId, noteAnchors.blockEntryId))
    .leftJoin(workMeta, eq(workMeta.entryId, addressable.workEntryId))
    .leftJoin(authors, eq(authors.id, workMeta.authorId))
    .where(and(...filters))
    .orderBy(desc(personalEntries.updatedAt), asc(notes.entryId));

  const bases = rows.map(toNoteOverviewBase);
  const cardsByNote = groupCardsByNote(
    await listNoteReviewCards(
      db,
      bases.map((base) => base.entryId),
      userId
    )
  );

  return bases.map((base) => ({
    ...base,
    review: summarizeNoteReview(cardsByNote.get(base.entryId) ?? [], now)
  }));
}

// A single note scoped to its owner (#659) — the authorization for the generic, non-work-scoped read,
// update, delete, and enrollment paths the Notes home uses. Unlike `getNoteForWork` the anchor is
// LEFT-joined, so a standalone (unanchored) note resolves too; `undefined` means the note does not exist
// for this user (a forged or cross-user id).
export async function getNoteForOwner(
  db: DbClient,
  noteEntryId: EntryId,
  userId: string
): Promise<NoteDto | undefined> {
  const rows = await db
    .select(noteColumns)
    .from(notes)
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .leftJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .where(and(eq(notes.entryId, noteEntryId), eq(personalEntries.userId, userId)))
    .limit(1);
  const row = rows[0];

  return row === undefined ? undefined : toNoteDto(row);
}

// A single note scoped to the work AND the current user, used to authorize edits and deletes
// against a forged or cross-work note id, or another user's note. Scoped through the block's
// `work_entry_id` (resolved over both legacy and PM blocks) so a note on a soft-deleted block stays
// editable/deletable for its work.
export async function getNoteForWork(
  db: DbClient,
  workEntryId: EntryId,
  noteEntryId: EntryId,
  userId: string
): Promise<NoteDto | undefined> {
  const addressable = addressableBlocks(db);
  const rows = await db
    .select(noteColumns)
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .innerJoin(addressable, eq(addressable.entryId, noteAnchors.blockEntryId))
    .where(
      and(
        eq(notes.entryId, noteEntryId),
        eq(addressable.workEntryId, workEntryId),
        eq(personalEntries.userId, userId)
      )
    )
    .limit(1);
  const row = rows[0];

  return row === undefined ? undefined : toNoteDto(row);
}

// The minimal facts Review enrollment (#658) needs about a saved note, authorized the same way as
// `getNoteForWork` (owner + work + existing anchor). Selecting the anchor's NOT NULL `selectedText`
// through the inner join makes the enrollment cue non-nullable at the type level, so the caller never
// carries a dead "anchor is null" branch. `undefined` means the note does not exist for this user/work
// or is unanchored (a standalone note has no anchor row and so is not enrollable here); `kind` lets the
// caller reject a bodyless Mark.
export type NoteEnrollmentTarget = Readonly<{
  kind: "note" | "mark";
  selectedTextSnapshot: string;
}>;

export async function getNoteEnrollmentTarget(
  db: DbClient,
  workEntryId: EntryId,
  noteEntryId: EntryId,
  userId: string
): Promise<NoteEnrollmentTarget | undefined> {
  const addressable = addressableBlocks(db);
  const rows = await db
    .select({ kind: notes.kind, selectedTextSnapshot: noteAnchors.selectedText })
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .innerJoin(personalEntries, eq(personalEntries.entryId, notes.entryId))
    .innerJoin(addressable, eq(addressable.entryId, noteAnchors.blockEntryId))
    .where(
      and(
        eq(notes.entryId, noteEntryId),
        eq(addressable.workEntryId, workEntryId),
        eq(personalEntries.userId, userId)
      )
    )
    .limit(1);

  return rows[0];
}
