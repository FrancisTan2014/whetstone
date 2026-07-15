import { type DocumentNodeJSON, documentText, isValidDocument } from "@whetstone/document";
import type { EntryId } from "@whetstone/domain";
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

// A persisted note or mark. `kind` discriminates the two: a `note` carries a canonical `bodyDoc` and
// its server-derived `bodyText`; a `mark` has neither (both null). The reader picks the annotation
// channel from `kind`, never from the body content.
export type NoteDto = Readonly<{
  anchor: NoteAnchorDto;
  blockEntryId: EntryId;
  bodyDoc: DocumentNodeJSON | null;
  bodyText: string | null;
  entryId: EntryId;
  kind: "note" | "mark";
}>;

export type NoteListDto = Readonly<{
  notes: ReadonlyArray<NoteDto>;
}>;

// A saved note enriched with the work it belongs to, for the cross-work Notes mode. Carries the
// note's `blockEntryId` (from `NoteDto`) plus the work title/author and `workEntryId` so the list
// can group by work and deep-link the reader to the anchored block.
export type NoteOverviewDto = NoteDto &
  Readonly<{
    authorName: string;
    workEntryId: EntryId;
    workTitle: string;
  }>;

export type NotesOverviewListDto = Readonly<{
  notes: ReadonlyArray<NoteOverviewDto>;
}>;

export function parseCreateNoteRequest(value: unknown): CreateNoteRequest {
  return createNoteRequestSchema.parse(value);
}

export function parseCreateMarkRequest(value: unknown): CreateMarkRequest {
  return createMarkRequestSchema.parse(value);
}

export function parseUpdateNoteRequest(value: unknown): UpdateNoteRequest {
  return updateNoteRequestSchema.parse(value);
}
