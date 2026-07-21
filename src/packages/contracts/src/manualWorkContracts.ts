import { z } from "zod";

import { documentJsonSchema } from "./diaryContracts.js";
import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";

// Shared, Zod-validated shapes for editing a learner-curated MANUAL Work in the Library (#720). A manual
// Work's content is one canonical ProseMirror/Tiptap document persisted as the same block rows as authored
// and imported content, but its authorization, lifecycle, and navigation are the Library's — kept separate
// from the authored Writing path (which owns owned essays). Every value crossing the manual-Work editing
// API is described here; the server validates once at the boundary and trusts the typed data inward.

// Saving a manual Work replaces its canonical document, but — unlike the latest-write-safe authored save —
// it carries the `revision` the editor loaded so the server can reject a stale save (another session wrote
// in between) instead of silently overwriting it. The document is validated against the shared document
// schema, so a malformed or unsafe body never reaches storage; unchanged nodes keep their stable ids.
export const updateManualWorkContentRequestSchema = z
  .object({
    document: documentJsonSchema,
    revision: z.string()
  })
  .strict();

export type UpdateManualWorkContentRequest = z.infer<typeof updateManualWorkContentRequestSchema>;

// A persisted manual Work with its canonical document — what the editor loads to edit and reopens after a
// save. `document` is the reassembled ProseMirror/Tiptap document (the reader renders it without
// conversion). `unitEntryId` is the single reading unit the blocks live under. `revision` is the
// optimistic-concurrency token (the owner's last-write timestamp): the editor echoes it on save and the
// server bumps it on every successful write.
export const manualWorkDtoSchema = z
  .object({
    createdAt: z.string(),
    document: documentJsonSchema,
    entryId: z.string(),
    language: workLanguageDtoSchema,
    revision: z.string(),
    title: z.string(),
    unitEntryId: z.string(),
    updatedAt: z.string(),
    workType: workTypeDtoSchema
  })
  .strict();

export type ManualWorkDto = z.infer<typeof manualWorkDtoSchema>;

export function parseUpdateManualWorkContentRequest(
  value: unknown
): UpdateManualWorkContentRequest {
  return updateManualWorkContentRequestSchema.parse(value);
}

export function parseManualWorkDto(value: unknown): ManualWorkDto {
  return manualWorkDtoSchema.parse(value);
}
