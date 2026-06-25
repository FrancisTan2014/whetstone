import {
  noteTemplates as domainNoteTemplates,
  renderNoteMarkdown,
  toEntryId,
  validateNoteAnswers,
  type EntryId,
  type NoteAnchor
} from "@whetstone/domain";
import type { CreateNoteRequest, NoteDto, UpdateNoteRequest } from "@whetstone/contracts";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, entryLinks, noteAnchors, noteTemplates, notes } from "../../db/schema.js";
import { findBlockInWork, getNoteForWork, getNoteTemplateById } from "./noteQueries.js";

// Real infrastructure boundaries (database client and id generation) are passed in so
// commands stay deterministic and testable.
export type NotesDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
}>;

export type CreateNoteResult =
  | Readonly<{ note: NoteDto; status: "created" }>
  | Readonly<{ status: "template_not_found" }>
  | Readonly<{ status: "block_not_found" }>
  | Readonly<{ reason: "empty" | "unknown_field"; status: "invalid_answers" }>
  | Readonly<{ status: "anchor_out_of_range" }>;

export type UpdateNoteResult =
  | Readonly<{ note: NoteDto; status: "updated" }>
  | Readonly<{ status: "note_not_found" }>
  | Readonly<{ status: "template_not_found" }>
  | Readonly<{ reason: "empty" | "unknown_field"; status: "invalid_answers" }>;

export type DeleteNoteResult =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "note_not_found" }>;

// Seed the v0 templates from the domain's canonical definitions. Idempotent: re-running
// inserts nothing for ids that already exist.
export async function seedNoteTemplates(db: DbClient): Promise<void> {
  const rows = domainNoteTemplates.map((template, index) => ({
    fieldsJson: template.fields,
    id: template.id,
    name: template.name,
    orderIndex: index
  }));

  await db.insert(noteTemplates).values(rows).onConflictDoNothing();
}

export async function createNote(
  dependencies: NotesDependencies,
  workEntryId: EntryId,
  request: CreateNoteRequest,
  userId: string
): Promise<CreateNoteResult> {
  const template = await getNoteTemplateById(dependencies.db, request.templateId);

  if (template === undefined) {
    return { status: "template_not_found" };
  }

  const validation = validateNoteAnswers(template, request.answers);

  if (validation.status !== "valid") {
    return { reason: validation.status, status: "invalid_answers" };
  }

  const block = await findBlockInWork(dependencies.db, workEntryId, request.anchor.blockEntryId);

  if (block === undefined) {
    return { status: "block_not_found" };
  }

  if (!anchorFitsBlock(request.anchor, block.plaintext)) {
    return { status: "anchor_out_of_range" };
  }

  const noteEntryId = toEntryId(dependencies.createEntryId());
  const anchor = request.anchor;
  const markdown = renderNoteMarkdown(template, validation.answers);

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: noteEntryId, type: "note" });
    await tx.insert(notes).values({
      answersJson: validation.answers,
      entryId: noteEntryId,
      markdownBody: markdown,
      templateId: template.id,
      userId
    });
    await tx.insert(noteAnchors).values({
      blockEntryId: anchor.blockEntryId,
      contextSnapshot: anchor.contextSnapshot,
      endOffset: anchor.endOffset ?? null,
      noteEntryId,
      selectedText: anchor.selectedTextSnapshot,
      startOffset: anchor.startOffset ?? null
    });
    await tx
      .insert(entryLinks)
      .values({ fromEntryId: noteEntryId, toEntryId: anchor.blockEntryId, type: "annotates" });
  });

  return {
    note: {
      anchor,
      answers: validation.answers,
      blockEntryId: anchor.blockEntryId,
      entryId: noteEntryId,
      markdown,
      templateId: template.id
    },
    status: "created"
  };
}

// Edit an existing note's template and answers. The anchor is fixed at capture time and is
// not changed here. The note must already belong to the work, so a forged or cross-work note
// id is rejected.
export async function updateNote(
  dependencies: NotesDependencies,
  workEntryId: EntryId,
  noteEntryId: EntryId,
  request: UpdateNoteRequest,
  userId: string
): Promise<UpdateNoteResult> {
  const existing = await getNoteForWork(dependencies.db, workEntryId, noteEntryId, userId);

  if (existing === undefined) {
    return { status: "note_not_found" };
  }

  const template = await getNoteTemplateById(dependencies.db, request.templateId);

  if (template === undefined) {
    return { status: "template_not_found" };
  }

  const validation = validateNoteAnswers(template, request.answers);

  if (validation.status !== "valid") {
    return { reason: validation.status, status: "invalid_answers" };
  }

  const markdown = renderNoteMarkdown(template, validation.answers);

  await dependencies.db
    .update(notes)
    .set({ answersJson: validation.answers, markdownBody: markdown, templateId: template.id })
    .where(eq(notes.entryId, noteEntryId));

  return {
    note: {
      ...existing,
      answers: validation.answers,
      markdown,
      templateId: template.id
    },
    status: "updated"
  };
}

// Delete a note and everything bound to it: its anchor, its `annotates` link, and the note
// Entry itself. Scoped to the work so a cross-work id cannot delete another work's note.
export async function deleteNote(
  dependencies: NotesDependencies,
  workEntryId: EntryId,
  noteEntryId: EntryId,
  userId: string
): Promise<DeleteNoteResult> {
  const existing = await getNoteForWork(dependencies.db, workEntryId, noteEntryId, userId);

  if (existing === undefined) {
    return { status: "note_not_found" };
  }

  await dependencies.db.transaction(async (tx) => {
    await tx
      .delete(entryLinks)
      .where(and(eq(entryLinks.fromEntryId, noteEntryId), eq(entryLinks.type, "annotates")));
    await tx.delete(noteAnchors).where(eq(noteAnchors.noteEntryId, noteEntryId));
    await tx.delete(notes).where(eq(notes.entryId, noteEntryId));
    await tx.delete(entries).where(eq(entries.id, noteEntryId));
  });

  return { status: "deleted" };
}

// Confirm the anchor genuinely comes from the block's stored plaintext. The recorded
// context snapshot must be part of the stored block, so a client cannot persist a valid
// block id, offsets, and selected text alongside a forged surrounding context. A sub-block
// range must then index exactly the selected text, and a whole-block selection must appear
// within the block.
function anchorFitsBlock(anchor: NoteAnchor, plaintext: string): boolean {
  if (!plaintext.includes(anchor.contextSnapshot)) {
    return false;
  }

  const { endOffset, startOffset } = anchor;

  if (startOffset === undefined || endOffset === undefined) {
    return plaintext.includes(anchor.selectedTextSnapshot);
  }

  return (
    endOffset <= plaintext.length &&
    plaintext.slice(startOffset, endOffset) === anchor.selectedTextSnapshot
  );
}
