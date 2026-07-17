import { documentText, type DocumentNodeJSON, isValidDocument } from "@whetstone/document";
import { z } from "zod";

// A ProseMirror/Tiptap document, validated against the shared document schema so a malformed or unsafe
// Question/Note body never reaches storage. Typed as `DocumentNodeJSON` for consumers.
const importDocumentSchema = z.custom<DocumentNodeJSON>(isValidDocument, {
  message: "must be a valid document."
});

// A document whose readable text is non-blank. Import is a Notes writer, not a Memory store: every row
// must carry both a real Question and a real Note before it lands, so a blank rich document (an empty
// paragraph) is rejected here at the boundary rather than creating an empty note or cue-less prompt.
const nonBlankDocumentSchema = importDocumentSchema.refine(
  (doc) => documentText(doc).trim().length > 0,
  { message: "must not be blank." }
);

// One row of a Notes import (#661): the edited Question document (becomes the note's cardless current-note
// prompt cue) and the edited Note document (becomes the standalone note's canonical body). Both are rich
// documents; the server derives their plaintext. There is no separate answer/context/reveal field — the
// parsed answer and any indented context are folded into the one Note document before import.
export const noteImportItemSchema = z
  .object({
    questionDoc: nonBlankDocumentSchema,
    noteDoc: nonBlankDocumentSchema
  })
  .strict();

export type NoteImportItem = z.infer<typeof noteImportItemSchema>;

// Import a batch of refined notebook rows (#661) as standalone Notes in one atomic write. Each row becomes
// exactly one `capture_source = import` note plus one cardless current-note prompt; either every row lands
// or none does. At least one row is required (an empty import is a client bug, never a silent no-op).
export const importNotesRequestSchema = z
  .object({
    items: z.array(noteImportItemSchema).min(1, { message: "at least one item is required." })
  })
  .strict();

export type ImportNotesRequest = z.infer<typeof importNotesRequestSchema>;

// One created note in an import result: its note Entry id and the id of the single cardless current-note
// prompt created under it. Returned in pasted order so the UI can report "Imported N notes" and focus the
// first result.
export const importedNoteDtoSchema = z
  .object({ noteEntryId: z.string().min(1), promptId: z.string().min(1) })
  .strict();

export type ImportedNoteDto = z.infer<typeof importedNoteDtoSchema>;

// The result of a Notes import (#661): every note created, in pasted order.
export const importNotesResultDtoSchema = z
  .object({ imported: z.array(importedNoteDtoSchema) })
  .strict();

export type ImportNotesResultDto = z.infer<typeof importNotesResultDtoSchema>;

export function parseImportNotesRequest(value: unknown): ImportNotesRequest {
  return importNotesRequestSchema.parse(value);
}

export function parseImportNotesResultDto(value: unknown): ImportNotesResultDto {
  return importNotesResultDtoSchema.parse(value);
}
