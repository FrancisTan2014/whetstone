import { z } from "zod";

import { documentJsonSchema } from "./diaryContracts.js";
import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";
import { MAX_WORK_CONTENT_REVISION, manualWorkSectionDtoSchema } from "./manualWorkContracts.js";

// Shared, Zod-validated shapes for CORRECTING a canonical imported Work in the Library editor (#762).
// Imported content stays shared content, not a personal Entry: a correction reuses the same canonical
// ProseMirror/Tiptap block model, Outline, and Work-scoped revision fence (#703) as the manual editor, but
// its authority is administrative rather than owner-scoped and it carries no `personal_entries` chronology.
// The section shape (`manualWorkSectionDtoSchema`) is origin-neutral, so it is reused verbatim rather than
// forked. Every value crossing the correction API is described here; the server validates once at the
// boundary and trusts the typed data inward.

const workContentRevisionSchema = z.number().int().nonnegative().max(MAX_WORK_CONTENT_REVISION);

// Saving a correction replaces one SECTION's canonical document and carries the `revision` the editor
// loaded (`work_meta.content_revision`, #703) so the server rejects a stale save instead of overwriting a
// concurrent write. The target section (reading unit) is named in the request path, not the body; the
// document is validated against the shared document schema so a malformed or unsafe body never reaches
// storage, and unchanged nodes keep their stable ids.
export const correctImportedWorkContentRequestSchema = z
  .object({
    document: documentJsonSchema,
    revision: workContentRevisionSchema
  })
  .strict();

export type CorrectImportedWorkContentRequest = z.infer<
  typeof correctImportedWorkContentRequestSchema
>;

// Adding a section appends a new reading unit (with a real heading block) to an imported Work under
// correction (#762). It carries the loaded `revision` for the same optimistic-concurrency protection as a
// save, so a section is never appended on top of another session's concurrent write.
export const addImportedWorkSectionRequestSchema = z
  .object({
    revision: workContentRevisionSchema
  })
  .strict();

export type AddImportedWorkSectionRequest = z.infer<typeof addImportedWorkSectionRequestSchema>;

// A persisted imported Work opened for correction, with the currently-opened section's canonical document
// and the whole Work's ordered section list (#762). Mirrors the manual editor DTO but omits owner
// chronology (`createdAt`/`updatedAt`) — an imported Work has no `personal_entries` facet — and adds
// `correctedAt`: the ISO instant the Work was first hand-corrected (`work_meta.manual_corrections_at`), or
// null when it is still exactly as ingested. `revision` is the Work-scoped optimistic-concurrency token the
// editor echoes on save/add and the server increments on every successful write.
export const importedWorkDtoSchema = z
  .object({
    correctedAt: z.string().nullable(),
    document: documentJsonSchema,
    entryId: z.string(),
    language: workLanguageDtoSchema,
    revision: workContentRevisionSchema,
    sections: z.array(manualWorkSectionDtoSchema),
    title: z.string(),
    unitEntryId: z.string(),
    workType: workTypeDtoSchema
  })
  .strict();

export type ImportedWorkDto = z.infer<typeof importedWorkDtoSchema>;

// One section's canonical document, loaded on demand when the administrator navigates the Outline to a
// section other than the one the editor opened with (#762). Work-scoped like the parent Work.
export const importedWorkUnitDtoSchema = z
  .object({
    document: documentJsonSchema,
    unitEntryId: z.string()
  })
  .strict();

export type ImportedWorkUnitDto = z.infer<typeof importedWorkUnitDtoSchema>;

export function parseCorrectImportedWorkContentRequest(
  value: unknown
): CorrectImportedWorkContentRequest {
  return correctImportedWorkContentRequestSchema.parse(value);
}

export function parseAddImportedWorkSectionRequest(value: unknown): AddImportedWorkSectionRequest {
  return addImportedWorkSectionRequestSchema.parse(value);
}

export function parseImportedWorkDto(value: unknown): ImportedWorkDto {
  return importedWorkDtoSchema.parse(value);
}

export function parseImportedWorkUnitDto(value: unknown): ImportedWorkUnitDto {
  return importedWorkUnitDtoSchema.parse(value);
}
