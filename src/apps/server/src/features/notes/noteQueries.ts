import { parseNoteTemplateDto, type NoteDto, type NoteTemplateDto } from "@whetstone/contracts";
import { toEntryId, type EntryId, type NoteAnchor } from "@whetstone/domain";
import { and, asc, eq, isNull } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, noteAnchors, noteTemplates, notes } from "../../db/schema.js";

type TemplateRow = Readonly<{
  fieldsJson: unknown;
  id: string;
  name: string;
}>;

const templateColumns = {
  fieldsJson: noteTemplates.fieldsJson,
  id: noteTemplates.id,
  name: noteTemplates.name
} as const;

function toTemplateDto(row: TemplateRow): NoteTemplateDto {
  return parseNoteTemplateDto({ fields: row.fieldsJson, id: row.id, name: row.name });
}

export async function listNoteTemplates(db: DbClient): Promise<ReadonlyArray<NoteTemplateDto>> {
  const rows = await db
    .select(templateColumns)
    .from(noteTemplates)
    .orderBy(asc(noteTemplates.orderIndex));

  return rows.map(toTemplateDto);
}

export async function getNoteTemplateById(
  db: DbClient,
  id: string
): Promise<NoteTemplateDto | undefined> {
  const rows = await db.select(templateColumns).from(noteTemplates).where(eq(noteTemplates.id, id));
  const row = rows[0];

  return row === undefined ? undefined : toTemplateDto(row);
}

export type BlockInWork = Readonly<{ plaintext: string }>;

// A note may only annotate an active block that belongs to the named work; this single
// lookup both confirms the block exists (and is not soft-deleted) and scopes it to the
// work via the block's own `work_entry_id`.
export async function findBlockInWork(
  db: DbClient,
  workEntryId: EntryId,
  blockEntryId: EntryId
): Promise<BlockInWork | undefined> {
  const rows = await db
    .select({ plaintext: blocks.plaintext })
    .from(blocks)
    .where(
      and(
        eq(blocks.entryId, blockEntryId),
        eq(blocks.workEntryId, workEntryId),
        isNull(blocks.deletedAt)
      )
    )
    .limit(1);
  const row = rows[0];

  return row === undefined ? undefined : { plaintext: row.plaintext };
}

type NoteRow = Readonly<{
  answersJson: unknown;
  blockEntryId: string;
  contextSnapshot: string;
  endOffset: number | null;
  entryId: string;
  markdownBody: string;
  selectedText: string;
  startOffset: number | null;
  templateId: string;
}>;

const noteColumns = {
  answersJson: notes.answersJson,
  blockEntryId: noteAnchors.blockEntryId,
  contextSnapshot: noteAnchors.contextSnapshot,
  endOffset: noteAnchors.endOffset,
  entryId: notes.entryId,
  markdownBody: notes.markdownBody,
  selectedText: noteAnchors.selectedText,
  startOffset: noteAnchors.startOffset,
  templateId: notes.templateId
} as const;

function toNoteAnchor(row: NoteRow): NoteAnchor {
  const base = {
    blockEntryId: toEntryId(row.blockEntryId),
    contextSnapshot: row.contextSnapshot,
    selectedTextSnapshot: row.selectedText
  };

  if (row.startOffset === null || row.endOffset === null) {
    return base;
  }

  return { ...base, endOffset: row.endOffset, startOffset: row.startOffset };
}

function toNoteDto(row: NoteRow): NoteDto {
  return {
    anchor: toNoteAnchor(row),
    answers: row.answersJson as Record<string, string>,
    blockEntryId: toEntryId(row.blockEntryId),
    entryId: toEntryId(row.entryId),
    markdown: row.markdownBody,
    templateId: row.templateId
  };
}

// All notes anchored to a block within the work, joined to their anchor. Scoped through
// the block's `work_entry_id` so notes on soft-deleted (unit-detached) blocks remain
// listed. Ordered by note id for a deterministic list; the client groups them by block.
export async function listNotesForWork(
  db: DbClient,
  workEntryId: EntryId
): Promise<ReadonlyArray<NoteDto>> {
  const rows = await db
    .select(noteColumns)
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .innerJoin(blocks, eq(blocks.entryId, noteAnchors.blockEntryId))
    .where(eq(blocks.workEntryId, workEntryId))
    .orderBy(asc(notes.entryId));

  return rows.map(toNoteDto);
}

// A single note scoped to the work, used to authorize edits and deletes against a forged or
// cross-work note id. Scoped through the block's `work_entry_id` so a note on a soft-deleted
// block stays editable/deletable for its work.
export async function getNoteForWork(
  db: DbClient,
  workEntryId: EntryId,
  noteEntryId: EntryId
): Promise<NoteDto | undefined> {
  const rows = await db
    .select(noteColumns)
    .from(notes)
    .innerJoin(noteAnchors, eq(noteAnchors.noteEntryId, notes.entryId))
    .innerJoin(blocks, eq(blocks.entryId, noteAnchors.blockEntryId))
    .where(and(eq(notes.entryId, noteEntryId), eq(blocks.workEntryId, workEntryId)))
    .limit(1);
  const row = rows[0];

  return row === undefined ? undefined : toNoteDto(row);
}
