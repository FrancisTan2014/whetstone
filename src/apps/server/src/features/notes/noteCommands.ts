import { toEntryId, type CaptureSource, type EntryId, type NoteAnchor } from "@whetstone/domain";
import { documentReadableText, type DocumentNodeJSON } from "@whetstone/document";
import type {
  CreateMarkRequest,
  CreateNoteRequest,
  NoteDto,
  UpdateNoteRequest
} from "@whetstone/contracts";
import { eq, inArray, or } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import {
  entries,
  entryLinks,
  memoryPrompts,
  noteAnchors,
  notes,
  personalEntries
} from "../../db/schema.js";
import { deleteReviewCardsAndEvents } from "../review/reviewCardCommands.js";
import { findBlockInWork, getNoteForWork, type BlockInWork } from "./noteQueries.js";

// The transaction handle drizzle passes into `db.transaction`, so the note insert/delete primitives can
// compose inside a caller's transaction — Reader capture opens its own, and Memory composes a note write
// (or delete) inside the SAME atomic write as its prompts and shared review cards.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

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
  | Readonly<{ status: "note_not_found" }>
  | Readonly<{ status: "note_not_editable" }>;

export type DeleteNoteResult =
  | Readonly<{ status: "deleted" }>
  | Readonly<{ status: "note_not_found" }>;

// Everything the Notes boundary needs to persist one unified note (#620), whatever captured it. A note
// carries its validated `bodyDoc` + server-derived `bodyText`; a mark carries neither (both null).
// `captureSource` is the structured provenance the caller supplies (Reader passes "reader"; Memory passes
// its own). `anchor` is the zero-or-one source anchor — a Reader note/Mark anchors to a block; a Memory or
// manual note passes `null`. `derivedFromEntryId` optionally records provenance to the source the note was
// derived from (a Memory deposit's source), written as a `derived_from` link.
export type InsertNoteParams = Readonly<{
  anchor: NoteAnchor | null;
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  captureSource: CaptureSource;
  derivedFromEntryId?: string | null;
  kind: "note" | "mark";
  noteEntryId: EntryId;
  now: Date;
  userId: string;
}>;

// Insert one unified note inside the caller's transaction: its Entry (`type: "note"`), the shared
// `personal_entries` ownership + chronology facet (occurredAt = createdAt at capture), and its `notes` row
// with the CALLER'S capture source. An anchored note additionally gets its `note_anchors` row and an
// `annotates` link to the block; an unanchored note gets neither. A supplied `derivedFromEntryId` records
// a `derived_from` provenance link. This is the single writer of a note's rows — Reader and Memory both
// compose it, so there is exactly one note facet and one body writer.
export async function insertNoteInTx(tx: Transaction, params: InsertNoteParams): Promise<void> {
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
    captureSource: params.captureSource,
    entryId: params.noteEntryId,
    kind: params.kind
  });
  if (params.anchor !== null) {
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
  }
  const derivedFromEntryId = params.derivedFromEntryId ?? null;
  if (derivedFromEntryId !== null) {
    await tx.insert(entryLinks).values({
      fromEntryId: params.noteEntryId,
      toEntryId: derivedFromEntryId,
      type: "derived_from"
    });
  }
}

// Delete a note and EVERYTHING bound to it inside the caller's transaction — the single owner-scoped
// cascade both Reader and Memory delete through (#620). It first tears down each Memory prompt the note
// `contains` (its shared review card + append-only events, via the review substrate), then the note's and
// prompts' `entry_links` (contains / derived_from / annotates), the prompt rows, the prompt Entries, the
// note's anchor row (if any), the note row, its personal-entry facet, and finally the note Entry. Children
// are removed before parents so every FK holds; a failed dependent delete rolls the whole transaction back,
// leaving the note and its review state intact. The caller authorizes ownership before composing this.
export async function deleteNoteInTx(tx: Transaction, noteEntryId: string): Promise<void> {
  const promptRows = await tx
    .select({ entryId: memoryPrompts.entryId })
    .from(memoryPrompts)
    .where(eq(memoryPrompts.noteEntryId, noteEntryId));
  const promptIds = promptRows.map((row) => row.entryId);
  const linkEntryIds = [noteEntryId, ...promptIds];

  await deleteReviewCardsAndEvents(tx, promptIds);
  await tx
    .delete(entryLinks)
    .where(
      or(inArray(entryLinks.fromEntryId, linkEntryIds), inArray(entryLinks.toEntryId, linkEntryIds))
    );
  await tx.delete(memoryPrompts).where(eq(memoryPrompts.noteEntryId, noteEntryId));
  if (promptIds.length > 0) {
    await tx.delete(entries).where(inArray(entries.id, promptIds));
  }
  await tx.delete(noteAnchors).where(eq(noteAnchors.noteEntryId, noteEntryId));
  await tx.delete(notes).where(eq(notes.entryId, noteEntryId));
  await tx.delete(personalEntries).where(eq(personalEntries.entryId, noteEntryId));
  await tx.delete(entries).where(eq(entries.id, noteEntryId));
}

// Capture a note from a reader selection (#619): the client supplies the anchor and the canonical rich
// `bodyDoc`; the readable `body_text` is ALWAYS derived here from that document, never trusted from the
// client. After the shared anchor checks pass, persist a `note` row (its body + `capture_source =
// 'reader'`) with its anchor and `annotates` link through the shared Notes boundary.
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
  const now = dependencies.now();

  await dependencies.db.transaction((tx) =>
    insertNoteInTx(tx, {
      anchor,
      bodyDoc,
      bodyText,
      captureSource: "reader",
      kind: "note",
      noteEntryId,
      now,
      userId
    })
  );

  return {
    note: readerNoteDto({ anchor, bodyDoc, bodyText, kind: "note", noteEntryId, now }),
    status: "created"
  };
}

// Create a mark (#255): a one-tap highlight with no body. Runs the same block + anchor checks a note
// does, then persists a bodyless `mark` row through the shared Notes boundary, so it reuses the anchor,
// overlap, list, and delete model with no new entity.
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
  const now = dependencies.now();

  await dependencies.db.transaction((tx) =>
    insertNoteInTx(tx, {
      anchor,
      bodyDoc: null,
      bodyText: null,
      captureSource: "reader",
      kind: "mark",
      noteEntryId,
      now,
      userId
    })
  );

  return {
    note: readerNoteDto({ anchor, bodyDoc: null, bodyText: null, kind: "mark", noteEntryId, now }),
    status: "created"
  };
}

// Project a just-captured Reader note/mark into its DTO: the capture is always anchored and its three
// chronology instants equal the capture `now`, so the client renders the row without a re-read.
function readerNoteDto(
  params: Readonly<{
    anchor: NoteAnchor;
    bodyDoc: DocumentNodeJSON | null;
    bodyText: string | null;
    kind: "note" | "mark";
    noteEntryId: EntryId;
    now: Date;
  }>
): NoteDto {
  const iso = params.now.toISOString();
  return {
    anchor: params.anchor,
    blockEntryId: params.anchor.blockEntryId,
    bodyDoc: params.bodyDoc,
    bodyText: params.bodyText,
    captureSource: "reader",
    createdAt: iso,
    entryId: params.noteEntryId,
    kind: params.kind,
    occurredAt: iso,
    updatedAt: iso
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

  // A Mark (#255) is a bodyless annotation: the `notes_kind_body_ck` constraint forbids it from
  // carrying a body doc/text. Reject the edit as a controlled boundary error here rather than writing
  // body columns onto a `kind='mark'` row and letting the DB CHECK turn a valid public request into an
  // internal failure. Only a `note` has an editable body.
  if (existing.kind !== "note") {
    return { status: "note_not_editable" };
  }

  const bodyDoc = request.bodyDoc;
  const bodyText = documentReadableText(bodyDoc);
  const now = dependencies.now();

  await dependencies.db.transaction(async (tx) => {
    await tx.update(notes).set({ bodyDoc, bodyText }).where(eq(notes.entryId, noteEntryId));
    // The note's owner/chronology lives in the shared `personal_entries` facet (#571); an edit is a
    // change to this Timeline-backed personal Entry, so bump `updated_at` in the same write.
    await tx
      .update(personalEntries)
      .set({ updatedAt: now })
      .where(eq(personalEntries.entryId, noteEntryId));
  });

  return {
    note: { ...existing, bodyDoc, bodyText, kind: "note", updatedAt: now.toISOString() },
    status: "updated"
  };
}

// Delete a note and everything bound to it through the single owner-scoped cascade (its anchor, links,
// and any Memory prompts/cards/events it owns). Scoped to the work so a cross-work id cannot delete
// another work's note.
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

  await dependencies.db.transaction((tx) => deleteNoteInTx(tx, noteEntryId));

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
