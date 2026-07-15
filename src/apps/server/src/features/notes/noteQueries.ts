import type { NoteDto, NoteOverviewDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";
import { toEntryId, type CaptureSource, type EntryId, type NoteAnchor } from "@whetstone/domain";
import { and, asc, eq, isNull } from "drizzle-orm";

import { addressableBlocks } from "../../db/addressableBlocks.js";
import type { DbClient } from "../../db/dbClient.js";
import {
  authors,
  noteAnchors,
  notes,
  personalEntries,
  readingUnits,
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

function toNoteOverviewDto(row: NoteOverviewRow): NoteOverviewDto {
  return {
    ...toNoteDto(row),
    authorName: row.authorName,
    workEntryId: row.workEntryId === null ? null : toEntryId(row.workEntryId),
    workTitle: row.workTitle
  };
}

// Every note the user owns, across all works, for the Notes mode. The anchor, its block's work, and the
// work's author are LEFT-joined because an unanchored note (a manual or Memory note with no source) has
// no anchor and therefore no work context — it is still listed, with null work fields, and the client
// shows its body only. Anchored notes carry their work title/author and `workEntryId` (resolved over both
// legacy and PM blocks; notes on soft-deleted blocks stay listed). Ordered by work title then note id so
// the client can group by work.
export async function listNotesForUser(
  db: DbClient,
  userId: string
): Promise<ReadonlyArray<NoteOverviewDto>> {
  const addressable = addressableBlocks(db);
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
    .where(eq(personalEntries.userId, userId))
    .orderBy(asc(workMeta.title), asc(notes.entryId));

  return rows.map(toNoteOverviewDto);
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
