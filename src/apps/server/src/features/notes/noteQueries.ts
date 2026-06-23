import { parseNoteTemplateDto, type NoteTemplateDto } from "@whetstone/contracts";
import type { EntryId } from "@whetstone/domain";
import { and, asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { blocks, noteTemplates, readingUnits } from "../../db/schema.js";

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

// A note may only annotate a block that belongs to the named work; this single lookup
// both confirms the block exists and scopes it to the work.
export async function findBlockInWork(
  db: DbClient,
  workEntryId: EntryId,
  blockEntryId: EntryId
): Promise<BlockInWork | undefined> {
  const rows = await db
    .select({ plaintext: blocks.plaintext })
    .from(blocks)
    .innerJoin(readingUnits, eq(blocks.readingUnitEntryId, readingUnits.entryId))
    .where(and(eq(blocks.entryId, blockEntryId), eq(readingUnits.workEntryId, workEntryId)))
    .limit(1);
  const row = rows[0];

  return row === undefined ? undefined : { plaintext: row.plaintext };
}
