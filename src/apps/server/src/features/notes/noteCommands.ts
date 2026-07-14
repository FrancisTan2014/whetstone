import { toEntryId, type EntryId, type NoteAnchor } from "@whetstone/domain";
import { documentReadableText, type DocumentNodeJSON } from "@whetstone/document";
import type {
  CreateMarkRequest,
  CreateNoteRequest,
  NoteDto,
  UpdateNoteRequest
} from "@whetstone/contracts";
import { and, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { entries, entryLinks, noteAnchors, notes, personalEntries } from "../../db/schema.js";
import { findBlockInWork, getNoteForWork, type BlockInWork } from "./noteQueries.js";

// Real infrastructure boundaries (database client, id generation, the clock) are passed in so
// commands stay deterministic and testable. `now` stamps the shared `personal_entries` chronology
// facet a note owns (occurredAt = createdAt at capture), the source of the note's ownership + time.
export type NotesDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
  now: () => Date;
}>;

export type CreateNoteResult =
  | Readonly<{ note: NoteDto; status: "created" }>
  | Readonly<{ status: "block_not_found" }>
  | Readonly<{ status: "anchor_out_of_range" }>;

// A mark (#255) shares the note anchor checks but has no body, so its only failure modes are the
// shared anchor checks a note also runs.
export type CreateMarkResult = CreateNoteResult;

export type UpdateNoteResult =
  | Readonly<{ note: NoteDto; status: "updated" }>
  | Readonly<{ status: "note_not_found" }>;

export type DeleteNoteResult =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "note_not_found" }>;

// Capture a note from a reader selection (#619): the client supplies the anchor and the canonical rich
// `bodyDoc`; the readable `body_text` is ALWAYS derived here from that document, never trusted from the
// client. After the shared anchor checks pass, persist a `note` row (its body + `capture_source =
// 'reader'`) with its anchor and `annotates` link.
export async function createNote(
  dependencies: NotesDependencies,
  workEntryId: EntryId,
  request: CreateNoteRequest,
  userId: string
): Promise<CreateNoteResult> {
  const blockCheck = await validateAnchorBlocks(dependencies.db, workEntryId, request.anchor);

  if (blockCheck !== "ok") {
    return { status: blockCheck };
  }

  const noteEntryId = toEntryId(dependencies.createEntryId());
  const anchor = request.anchor;
  const bodyDoc = request.bodyDoc;
  const bodyText = documentReadableText(bodyDoc);

  await persistNoteWithAnchor(dependencies.db, {
    anchor,
    bodyDoc,
    bodyText,
    kind: "note",
    noteEntryId,
    now: dependencies.now(),
    userId
  });

  return {
    note: {
      anchor,
      blockEntryId: anchor.blockEntryId,
      bodyDoc,
      bodyText,
      entryId: noteEntryId,
      kind: "note"
    },
    status: "created"
  };
}

// Insert a note (a rich body) or a mark (no body) with its anchor and `annotates` link in one
// transaction. `body_doc`/`body_text` are null for a mark (#255); a note carries its validated document
// and server-derived text. Single owner of note row + its `personal_entries` chronology facet (owner +
// timestamps; occurredAt = createdAt at capture) + anchor + link creation.
async function persistNoteWithAnchor(
  db: DbClient,
  params: Readonly<{
    anchor: NoteAnchor;
    bodyDoc: DocumentNodeJSON | null;
    bodyText: string | null;
    kind: "note" | "mark";
    noteEntryId: EntryId;
    now: Date;
    userId: string;
  }>
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(entries).values({ id: params.noteEntryId, type: "note" });
    await tx.insert(personalEntries).values({
      createdAt: params.now,
      entryId: params.noteEntryId,
      occurredAt: params.now,
      updatedAt: params.now,
      userId: params.userId
    });
    await tx.insert(notes).values({
      bodyDoc: params.bodyDoc,
      bodyText: params.bodyText,
      captureSource: "reader",
      entryId: params.noteEntryId,
      kind: params.kind
    });
    await tx.insert(noteAnchors).values({
      blockEntryId: params.anchor.blockEntryId,
      contextSnapshot: params.anchor.contextSnapshot,
      endBlockEntryId: params.anchor.endBlockEntryId,
      endOffset: params.anchor.endOffset ?? null,
      noteEntryId: params.noteEntryId,
      selectedText: params.anchor.selectedTextSnapshot,
      startOffset: params.anchor.startOffset ?? null
    });
    await tx.insert(entryLinks).values({
      fromEntryId: params.noteEntryId,
      toEntryId: params.anchor.blockEntryId,
      type: "annotates"
    });
  });
}

// Create a mark (#255): a one-tap highlight with no body. Runs the same block + anchor checks a note
// does, then persists a bodyless `mark` row, so it reuses the anchor, overlap, list, and delete model
// with no new entity.
export async function createMark(
  dependencies: NotesDependencies,
  workEntryId: EntryId,
  request: CreateMarkRequest,
  userId: string
): Promise<CreateMarkResult> {
  const blockCheck = await validateAnchorBlocks(dependencies.db, workEntryId, request.anchor);

  if (blockCheck !== "ok") {
    return { status: blockCheck };
  }

  const noteEntryId = toEntryId(dependencies.createEntryId());
  const anchor = request.anchor;

  await persistNoteWithAnchor(dependencies.db, {
    anchor,
    bodyDoc: null,
    bodyText: null,
    kind: "mark",
    noteEntryId,
    now: dependencies.now(),
    userId
  });

  return {
    note: {
      anchor,
      blockEntryId: anchor.blockEntryId,
      bodyDoc: null,
      bodyText: null,
      entryId: noteEntryId,
      kind: "mark"
    },
    status: "created"
  };
}

// Edit an existing note's canonical body (#619): replace `body_doc` with the supplied document and
// re-derive `body_text` from it on the server. The anchor is fixed at capture time and is not changed
// here; the row stays a `note`. The note must already belong to the work, so a forged or cross-work note
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

  const bodyDoc = request.bodyDoc;
  const bodyText = documentReadableText(bodyDoc);

  await dependencies.db.transaction(async (tx) => {
    await tx.update(notes).set({ bodyDoc, bodyText }).where(eq(notes.entryId, noteEntryId));
    // The note's owner/chronology lives in the shared `personal_entries` facet (#571); an edit is a
    // change to this Timeline-backed personal Entry, so bump `updated_at` in the same write.
    await tx
      .update(personalEntries)
      .set({ updatedAt: dependencies.now() })
      .where(eq(personalEntries.entryId, noteEntryId));
  });

  return {
    note: { ...existing, bodyDoc, bodyText, kind: "note" },
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
    await tx.delete(personalEntries).where(eq(personalEntries.entryId, noteEntryId));
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

// A cross-block span (#257) anchors a start offset in the start block and an end offset in the end
// block; each offset must fall within its own block's plaintext. The single-block context/slice
// checks do not apply because the selected text spans blocks.
function spanFitsBlocks(anchor: NoteAnchor, startText: string, endText: string): boolean {
  const { endOffset, startOffset } = anchor;

  return (
    startOffset !== undefined &&
    endOffset !== undefined &&
    startOffset <= startText.length &&
    endOffset <= endText.length
  );
}

// Confirm a note's anchor blocks belong to the work and its offsets fit: a single-block anchor uses
// the strict context/slice check; a cross-block span additionally requires the end block to exist in
// the work and each offset to fall within its block. Shared by note and mark creation.
async function validateAnchorBlocks(
  db: DbClient,
  workEntryId: EntryId,
  anchor: NoteAnchor
): Promise<"anchor_out_of_range" | "block_not_found" | "ok"> {
  const startBlock = await findBlockInWork(db, workEntryId, anchor.blockEntryId);

  if (startBlock === undefined) {
    return "block_not_found";
  }

  if (anchor.endBlockEntryId === anchor.blockEntryId) {
    return anchorFitsBlock(anchor, startBlock.plaintext) ? "ok" : "anchor_out_of_range";
  }

  const endBlock = await findBlockInWork(db, workEntryId, anchor.endBlockEntryId);

  if (endBlock === undefined) {
    return "block_not_found";
  }

  if (!spanFitsBlocks(anchor, startBlock.plaintext, endBlock.plaintext)) {
    return "anchor_out_of_range";
  }

  // A cross-block span must stay within one reading unit and run forward: the end block in the same
  // unit at an equal-or-later position. A reversed or cross-unit span would render no highlight, so
  // reject it rather than persist a dead anchor (#257).
  if (!spanRunsForwardInOneUnit(startBlock, endBlock)) {
    return "anchor_out_of_range";
  }

  return "ok";
}

// Whether a span's end block follows its start block within the same reading unit (an equal-or-later
// block index), which is the only shape the reader lays out and highlights.
function spanRunsForwardInOneUnit(start: BlockInWork, end: BlockInWork): boolean {
  return start.unitOrderIndex === end.unitOrderIndex && start.orderIndex <= end.orderIndex;
}
