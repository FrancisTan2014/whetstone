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

export type NoteDto = Readonly<{
  anchor: NoteAnchorDto;
  answers: Readonly<Record<string, string>>;
  blockEntryId: EntryId;
  entryId: EntryId;
  markdown: string;
  templateId: string;
}>;

export type NoteTemplateListDto = Readonly<{
  templates: ReadonlyArray<NoteTemplateDto>;
}>;

export function parseCreateNoteRequest(value: unknown): CreateNoteRequest {
  return createNoteRequestSchema.parse(value);
}

export function parseNoteTemplateDto(value: unknown): NoteTemplateDto {
  return noteTemplateDtoSchema.parse(value);
}
