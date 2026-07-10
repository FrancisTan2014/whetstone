import { z } from "zod";

import { documentJsonSchema } from "./diaryContracts.js";
import { workLanguageDtoSchema, workTypeDtoSchema } from "./entryContracts.js";

// Shared, Zod-validated shapes for user-owned authored Works (#576): a Work the current user creates in
// the shared rich editor, whose canonical content is a ProseMirror/Tiptap document persisted as the same
// block rows as ingested content. Every value crossing the authoring API is described here; the server
// validates once at the boundary and trusts the typed data inward.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// Creating an authored Work asks only for the minimal metadata (a plain title, language, and supported
// Work type) before the editor opens; the current user is the author, so no author selection is taken.
export const createAuthoredWorkRequestSchema = z
  .object({
    language: workLanguageDtoSchema,
    title: z.string().refine(isNonBlank, { message: "Work title must be non-empty." }),
    workType: workTypeDtoSchema
  })
  .strict();

export type CreateAuthoredWorkRequest = z.infer<typeof createAuthoredWorkRequestSchema>;

// Saving an authored Work replaces its canonical document wholesale (latest-write-safe): the client sends
// the full editor document, validated against the shared document schema so a malformed or unsafe body
// never reaches storage. Unchanged nodes keep their stable ids, so existing note anchors stay valid.
export const updateAuthoredWorkContentRequestSchema = z
  .object({
    document: documentJsonSchema
  })
  .strict();

export type UpdateAuthoredWorkContentRequest = z.infer<
  typeof updateAuthoredWorkContentRequestSchema
>;

// A persisted authored Work with its canonical document — what the editor loads to edit or read. The
// `document` is the reassembled ProseMirror/Tiptap document (the reader renders it without conversion).
// `unitEntryId` is the single reading unit the blocks live under. Timestamps come from the shared
// personal-entry chronology facet.
export const authoredWorkDtoSchema = z
  .object({
    createdAt: z.string(),
    document: documentJsonSchema,
    entryId: z.string(),
    language: workLanguageDtoSchema,
    title: z.string(),
    unitEntryId: z.string(),
    updatedAt: z.string(),
    workType: workTypeDtoSchema
  })
  .strict();

export type AuthoredWorkDto = z.infer<typeof authoredWorkDtoSchema>;

// A lightweight authored-Work summary (no document body) — used to mark which Library works are authored
// drafts and to surface the most recently edited one on Today's "Continue writing" card.
export const authoredWorkSummaryDtoSchema = z
  .object({
    createdAt: z.string(),
    entryId: z.string(),
    language: workLanguageDtoSchema,
    title: z.string(),
    updatedAt: z.string(),
    workType: workTypeDtoSchema
  })
  .strict();

export type AuthoredWorkSummaryDto = z.infer<typeof authoredWorkSummaryDtoSchema>;

export const authoredWorkListDtoSchema = z
  .object({ works: z.array(authoredWorkSummaryDtoSchema) })
  .strict();

export type AuthoredWorkListDto = z.infer<typeof authoredWorkListDtoSchema>;

// Today's "Continue writing" target: the most recently edited authored Work, or null when the user has
// authored nothing yet.
export const continueWritingDtoSchema = z
  .object({ work: authoredWorkSummaryDtoSchema.nullable() })
  .strict();

export type ContinueWritingDto = z.infer<typeof continueWritingDtoSchema>;

export function parseCreateAuthoredWorkRequest(value: unknown): CreateAuthoredWorkRequest {
  return createAuthoredWorkRequestSchema.parse(value);
}

export function parseUpdateAuthoredWorkContentRequest(
  value: unknown
): UpdateAuthoredWorkContentRequest {
  return updateAuthoredWorkContentRequestSchema.parse(value);
}

export function parseAuthoredWorkDto(value: unknown): AuthoredWorkDto {
  return authoredWorkDtoSchema.parse(value);
}

export function parseAuthoredWorkListDto(value: unknown): AuthoredWorkListDto {
  return authoredWorkListDtoSchema.parse(value);
}

export function parseContinueWritingDto(value: unknown): ContinueWritingDto {
  return continueWritingDtoSchema.parse(value);
}
