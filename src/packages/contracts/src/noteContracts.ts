import {
  noteFieldTypes,
  type EntryId,
  type NoteTemplate,
  type NoteTemplateField
} from "@whetstone/domain";
import { z } from "zod";

import { noteAnchorDtoSchema, type NoteAnchorDto } from "./entryContracts.js";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export type NoteTemplateFieldDto = NoteTemplateField;
export type NoteTemplateDto = NoteTemplate;

export const noteFieldTypeDtoSchema = z.enum(noteFieldTypes);

const noteTemplateFieldDtoSchema = z
  .object({
    id: z.string().refine(isNonBlank, { message: "field id must be non-empty." }),
    label: z.string().refine(isNonBlank, { message: "field label must be non-empty." }),
    type: noteFieldTypeDtoSchema
  })
  .strict();

export const noteTemplateDtoSchema = z
  .object({
    fields: z.array(noteTemplateFieldDtoSchema).min(1),
    id: z.string().refine(isNonBlank, { message: "template id must be non-empty." }),
    name: z.string().refine(isNonBlank, { message: "template name must be non-empty." })
  })
  .strict();

// Answers arrive as a string map keyed by template field id; which keys are allowed
// depends on the chosen template, so that check happens in the server command against
// the seeded template, not here at the shape boundary.
export const createNoteRequestSchema = z
  .object({
    answers: z.record(z.string(), z.string()),
    anchor: noteAnchorDtoSchema,
    templateId: z.string().refine(isNonBlank, { message: "templateId must be non-empty." })
  })
  .strict();

export type CreateNoteRequest = z.infer<typeof createNoteRequestSchema>;

// A mark-only highlight (a "Gem", #255): one tap saves a highlight with no template or body, so the
// request carries only the anchor. The mark reuses the note anchor + overlap + delete model; it is
// stored as a note with a null template and empty body.
export const createMarkRequestSchema = z
  .object({
    anchor: noteAnchorDtoSchema
  })
  .strict();

export type CreateMarkRequest = z.infer<typeof createMarkRequestSchema>;

// Editing a note changes its template and answers; the anchor (which block and where) is
// fixed at capture time, so it is not part of the update.
export const updateNoteRequestSchema = z
  .object({
    answers: z.record(z.string(), z.string()),
    templateId: z.string().refine(isNonBlank, { message: "templateId must be non-empty." })
  })
  .strict();

export type UpdateNoteRequest = z.infer<typeof updateNoteRequestSchema>;

export type NoteDto = Readonly<{
  anchor: NoteAnchorDto;
  answers: Readonly<Record<string, string>>;
  blockEntryId: EntryId;
  entryId: EntryId;
  markdown: string;
  // Null for a mark-only highlight (a "Gem", #255), which has no template or body; a string for a
  // templated note. The reader picks the gem hue for a null template.
  templateId: string | null;
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

export type NoteTemplateListDto = Readonly<{
  templates: ReadonlyArray<NoteTemplateDto>;
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

export function parseNoteTemplateDto(value: unknown): NoteTemplateDto {
  return noteTemplateDtoSchema.parse(value);
}
