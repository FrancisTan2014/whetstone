import { z } from "zod";

import { documentJsonSchema } from "./diaryContracts.js";
import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";

// Shared, Zod-validated shapes for editing a learner-curated MANUAL Work in the Library (#720). A manual
// Work's content is one canonical ProseMirror/Tiptap document persisted as the same block rows as authored
// and imported content, but its authorization, lifecycle, and navigation are the Library's — kept separate
// from the authored Writing path (which owns owned essays). Every value crossing the manual-Work editing
// API is described here; the server validates once at the boundary and trusts the typed data inward.

// Saving a manual Work replaces one SECTION's canonical document, but — unlike the latest-write-safe
// authored save — it carries the `revision` the editor loaded so the server can reject a stale save
// (another session wrote in between) instead of silently overwriting it. `revision` is the Work-scoped
// content revision (`work_meta.content_revision`, #703): a monotonic non-negative integer, not a
// timestamp. The target section (reading unit) is named in the request path, not the body. The document
// is validated against the shared document schema, so a malformed or unsafe body never reaches storage;
// unchanged nodes keep their stable ids.
export const updateManualWorkContentRequestSchema = z
  .object({
    document: documentJsonSchema,
    revision: z.number().int().nonnegative()
  })
  .strict();

export type UpdateManualWorkContentRequest = z.infer<typeof updateManualWorkContentRequestSchema>;

// Adding a section appends a new reading unit (with a real heading block) to a manual Work (#697). It
// carries the loaded `revision` (the Work-scoped content revision) for the same optimistic-concurrency
// protection as a save, so a section is never appended on top of another session's concurrent write.
export const addManualWorkSectionRequestSchema = z
  .object({
    revision: z.number().int().nonnegative()
  })
  .strict();

export type AddManualWorkSectionRequest = z.infer<typeof addManualWorkSectionRequestSchema>;

// One entry of a manual Work's live Outline (#697): the ordered reading unit a section occupies, plus
// the heading identity DERIVED from its first persisted block — the heading `level` (1-6) it starts at
// and its `title` text. Both are absent for a section that does not start at a heading (only ever the
// leading pre-heading section) or an empty heading; the outline projection maps the absence to a root
// "Start" / an untitled label. Nothing here is a stored TOC copy — it is recomputed from the blocks on
// every read.
export const manualWorkSectionDtoSchema = z
  .object({
    headingLevel: z.number().optional(),
    orderIndex: z.number(),
    title: z.string().optional(),
    unitEntryId: z.string()
  })
  .strict();

export type ManualWorkSectionDto = z.infer<typeof manualWorkSectionDtoSchema>;

// A persisted manual Work with the currently-opened section's canonical document and the whole Work's
// ordered section list (#697/#720). `document` is the reassembled ProseMirror/Tiptap document of the
// section named by `unitEntryId` (the reader renders it without conversion). `sections` is the source
// the editor and Reader both derive the live Outline from. `revision` is the Work-scoped
// optimistic-concurrency token (`work_meta.content_revision`, #703 — a monotonic non-negative integer):
// the editor echoes it on save/add and the server increments it on every successful write. `updatedAt` is
// the owner's chronology, reported for display only and never used to fence a write.
export const manualWorkDtoSchema = z
  .object({
    createdAt: z.string(),
    document: documentJsonSchema,
    entryId: z.string(),
    language: workLanguageDtoSchema,
    revision: z.number().int().nonnegative(),
    sections: z.array(manualWorkSectionDtoSchema),
    title: z.string(),
    unitEntryId: z.string(),
    updatedAt: z.string(),
    workType: workTypeDtoSchema
  })
  .strict();

export type ManualWorkDto = z.infer<typeof manualWorkDtoSchema>;

// One section's canonical document, loaded on demand when the learner navigates the Outline to a
// section other than the one the editor opened with (#697). Owner/work-scoped like the parent Work.
export const manualWorkUnitDtoSchema = z
  .object({
    document: documentJsonSchema,
    unitEntryId: z.string()
  })
  .strict();

export type ManualWorkUnitDto = z.infer<typeof manualWorkUnitDtoSchema>;

export function parseUpdateManualWorkContentRequest(
  value: unknown
): UpdateManualWorkContentRequest {
  return updateManualWorkContentRequestSchema.parse(value);
}

export function parseAddManualWorkSectionRequest(value: unknown): AddManualWorkSectionRequest {
  return addManualWorkSectionRequestSchema.parse(value);
}

export function parseManualWorkDto(value: unknown): ManualWorkDto {
  return manualWorkDtoSchema.parse(value);
}

export function parseManualWorkUnitDto(value: unknown): ManualWorkUnitDto {
  return manualWorkUnitDtoSchema.parse(value);
}
