import { type DocumentNodeJSON, documentText, isValidDocument } from "@whetstone/document";
import type { CaptureSource, EntryId } from "@whetstone/domain";
import { z } from "zod";

import { noteAnchorDtoSchema, type NoteAnchorDto } from "./entryContracts.js";

// A note's canonical body is a ProseMirror/Tiptap document, validated against the shared document
// schema AND required to be non-blank: a note is authored content, so an empty document is not a note.
// The plaintext projection is derived on the server, never supplied by the client — this schema is the
// only body a create/update request may carry.
export const noteBodyDocSchema = z.custom<DocumentNodeJSON>(
  (value) => isValidDocument(value) && documentText(value as DocumentNodeJSON).trim().length > 0,
  { message: "must be a valid, non-blank document." }
);

// Creating a note carries the reader anchor (which block and where) plus the canonical rich body.
// There is no template choice and no client-supplied plaintext: `body_text` is derived on the server.
export const createNoteRequestSchema = z
  .object({
    anchor: noteAnchorDtoSchema,
    bodyDoc: noteBodyDocSchema
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

// Creating a manual note from the Notes overview (#575): a deliberate "New note" with no source anchor,
// carrying only the canonical rich body. The server persists it as an unanchored `note` with
// `capture_source = 'manual'` and no prompt/card — review enrollment is always a separate, explicit step.
// As with anchored capture there is no client-supplied plaintext: `body_text` is derived on the server.
export const createStandaloneNoteRequestSchema = z
  .object({
    bodyDoc: noteBodyDocSchema
  })
  .strict();

export type CreateStandaloneNoteRequest = z.infer<typeof createStandaloneNoteRequestSchema>;

// A mark-only highlight (a "Gem", #255): one tap saves a highlight with no body, so the request
// carries only the anchor. The mark reuses the note anchor + overlap + delete model; it is stored as a
// bodyless note (`kind = "mark"`).
export const createMarkRequestSchema = z
  .object({
    anchor: noteAnchorDtoSchema
  })
  .strict();

export type CreateMarkRequest = z.infer<typeof createMarkRequestSchema>;

// Editing a note replaces its canonical rich body. The anchor (which block and where) is fixed at
// capture time, so it is not part of the update; the server re-derives `body_text` from the new body.
export const updateNoteRequestSchema = z
  .object({
    bodyDoc: noteBodyDocSchema
  })
  .strict();

export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

// A persisted note or mark — the learner's one durable Note type (#620). `kind` discriminates the two
// content shapes: a `note` carries a canonical `bodyDoc` and its server-derived `bodyText`; a `mark` has
// neither (both null). `captureSource` is how it was captured (structured provenance). `anchor` is its
// zero-or-one source anchor — present for an anchored Reader note/Mark, `null` for an unanchored manual or
// Memory note (whose absence is a normal state, not an error); `blockEntryId` mirrors the anchor's block
// (null when unanchored). `createdAt`/`updatedAt`/`occurredAt` are ISO instants from the shared
// personal-entry chronology facet. Scheduler fields and prompt lifecycle NEVER appear here — Memory is
// behavior applied to a note, not part of it.
export type NoteDto = Readonly<{
  anchor: NoteAnchorDto | null;
  blockEntryId: EntryId | null;
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  captureSource: CaptureSource;
  createdAt: string;
  entryId: EntryId;
  kind: "note" | "mark";
  occurredAt: string;
  updatedAt: string;
}>;

export type NoteListDto = Readonly<{
  notes: ReadonlyArray<NoteDto>;
}>;

// A note known to be anchored — the Reader's shape, where the source anchor and its block are always
// present (the work-scoped note reads return only anchored notes/marks). Narrowing to this at the Reader
// boundary lets reader code render highlights and jump to blocks without re-checking the shared nullable
// anchor on every access.
export type AnchoredNoteDto = NoteDto & Readonly<{ anchor: NoteAnchorDto; blockEntryId: EntryId }>;

// Narrow a note to its anchored shape. `anchor` and `blockEntryId` are all-or-nothing (an anchored note
// carries both, an unanchored one neither), so a non-null anchor is a sound witness that the note is
// anchored.
export function isAnchoredNote(note: NoteDto): note is AnchoredNoteDto {
  return note.anchor !== null;
}

// A saved note enriched with the work it belongs to, for the cross-work Notes mode. An anchored note
// carries its `blockEntryId` (from `NoteDto`) plus the work title/author and `workEntryId` so the list can
// group by work and deep-link the reader to the anchored block. An unanchored note (a manual or Memory
// note with no source) has no work context, so those three fields are `null` and the row shows its body
// only.
export type NoteOverviewDto = NoteDto &
  Readonly<{
    authorName: string | null;
    workEntryId: EntryId | null;
    workTitle: string | null;
  }>;

export type NotesOverviewListDto = Readonly<{
  notes: ReadonlyArray<NoteOverviewDto>;
}>;

// An overview note known to be anchored — it carries its source anchor, the anchored block, and the work
// context (title + id) the Notes overview deep-links into. `authorName` stays nullable because a work may
// have no recorded author even when the note is anchored.
export type AnchoredNoteOverviewDto = NoteOverviewDto &
  Readonly<{
    anchor: NoteAnchorDto;
    blockEntryId: EntryId;
    workEntryId: EntryId;
    workTitle: string;
  }>;

// Narrow an overview note to its anchored shape. As with `isAnchoredNote`, a non-null anchor is the sound
// witness — the anchor, block, and work context are supplied together by the same source join.
export function isAnchoredNoteOverview(note: NoteOverviewDto): note is AnchoredNoteOverviewDto {
  return note.anchor !== null;
}

export function parseCreateNoteRequest(value: unknown): CreateNoteRequest {
  return createNoteRequestSchema.parse(value);
}

export function parseCreateStandaloneNoteRequest(value: unknown): CreateStandaloneNoteRequest {
  return createStandaloneNoteRequestSchema.parse(value);
}

export function parseCreateMarkRequest(value: unknown): CreateMarkRequest {
  return createMarkRequestSchema.parse(value);
}

export function parseUpdateNoteRequest(value: unknown): UpdateNoteRequest {
  return updateNoteRequestSchema.parse(value);
}
