import { z } from "zod";

import { pdfImportAttemptStates } from "@whetstone/domain";

// The narrow, owner-scoped contract for the recoverable staged PDF import (#721). An attempt owns import
// EXECUTION state only — staged bytes, a bounded conversion run, and its per-range checkpoints — and
// never a Work, ReadingUnit, or Block. Publication (#702) is a separate owner. These are the shapes the
// start / status / cancel / retry contract exchanges; the server validates once at its boundary.
//
// The attempt state literal is sourced from `domain` (`pdfImportAttemptStates`) so the DB enum, the pure
// state machine, and this DTO can never drift apart.
export const pdfImportAttemptStateSchema = z.enum(pdfImportAttemptStates);

export type PdfImportAttemptStateDto = z.infer<typeof pdfImportAttemptStateSchema>;

// A `failed` attempt's typed failure, projected from the adapter's named failure (#701). It carries a
// stable `kind`, a human `message`, and an actionable `remedy` — never converter JSON or extracted
// learning content, which are kept out of the failure columns by construction. `kind` is a non-empty
// string (the adapter owns the exact set) so this contract does not have to be revised in lockstep with
// every new adapter failure mode.
export const pdfImportFailureDtoSchema = z
  .object({
    kind: z.string().min(1),
    message: z.string().min(1),
    remedy: z.string().min(1)
  })
  .strict();

export type PdfImportFailureDto = z.infer<typeof pdfImportFailureDtoSchema>;

// The one attempt-owned stage, reported as presence only — never a server filesystem path. `bound` is
// true while the attempt owns staged bytes (created and bound, not yet removed by success/cancel/expiry).
export const pdfImportStageDtoSchema = z.object({ bound: z.boolean() }).strict();

export type PdfImportStageDto = z.infer<typeof pdfImportStageDtoSchema>;

// The pollable status of one import attempt. Progress is reported as concrete page and range COUNTS
// derived from committed ranges, never a percentage parsed from a subprocess. `totalPages`/`totalRanges`
// are null until the source has been probed. `failure` is set only for `failed` (null otherwise).
// `adapterFingerprint` records the exact converter build a committed range was produced under, so a
// resumed run reuses only ranges from the current build.
export const pdfImportStatusDtoSchema = z
  .object({
    adapterFingerprint: z.string().nullable(),
    attemptId: z.string().min(1),
    completedPages: z.number().int().nonnegative(),
    completedRanges: z.number().int().nonnegative(),
    createdAt: z.string(),
    failure: pdfImportFailureDtoSchema.nullable(),
    heartbeatAt: z.string().nullable(),
    sourceHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "sourceHash must be 64 lowercase hex characters."),
    stage: pdfImportStageDtoSchema,
    state: pdfImportAttemptStateSchema,
    totalPages: z.number().int().nonnegative().nullable(),
    totalRanges: z.number().int().nonnegative().nullable(),
    updatedAt: z.string()
  })
  .strict();

export type PdfImportStatusDto = z.infer<typeof pdfImportStatusDtoSchema>;

// The start response: the created attempt's id and its initial status (always `queued`), so the caller
// can begin polling immediately without waiting for the conversion slot.
export const pdfImportStartedDtoSchema = z
  .object({ attemptId: z.string().min(1), status: pdfImportStatusDtoSchema })
  .strict();

export type PdfImportStartedDto = z.infer<typeof pdfImportStartedDtoSchema>;

export function parsePdfImportStatusDto(value: unknown): PdfImportStatusDto {
  return pdfImportStatusDtoSchema.parse(value);
}

export function parsePdfImportStartedDto(value: unknown): PdfImportStartedDto {
  return pdfImportStartedDtoSchema.parse(value);
}

// The learner's upload-time intent that accompanies a born-digital PDF upload (#702). All three metadata
// fields are optional: publication resolves a missing title from the filename stem and a missing
// author/language from neutral defaults. `fileName` is required (its stem is the title fallback and it is
// recorded as provenance) and never a filesystem path — the client sends only the picked file's name.
export const pdfImportStartMetadataSchema = z
  .object({
    enteredAuthor: z.string().nullable().default(null),
    enteredLanguage: z.string().nullable().default(null),
    enteredTitle: z.string().nullable().default(null),
    fileName: z.string().min(1)
  })
  .strict();

export type PdfImportStartMetadataDto = z.infer<typeof pdfImportStartMetadataSchema>;

// The result of starting a born-digital PDF import (#702). `reopened` = identical bytes already own a
// Work (#706 exact claim), so the caller opens it directly with no new attempt. `queued` = a fresh
// recoverable attempt (#721) whose completion the server publishes; the caller polls `attemptId`.
export const pdfImportBeginResultDtoSchema = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("reopened"), workEntryId: z.string().min(1) }).strict(),
  z
    .object({
      attemptId: z.string().min(1),
      outcome: z.literal("queued"),
      status: pdfImportStatusDtoSchema
    })
    .strict()
]);

export type PdfImportBeginResultDto = z.infer<typeof pdfImportBeginResultDtoSchema>;

// The publication outcome of an attempt (#702), served alongside its #721 execution status. `none` = the
// attempt carries no publication intent (a bare #721 attempt); `pending` = converted but not yet
// published (or not yet converted); `published` = a canonical Work is ready to open; `ocr_required` = a
// typed refusal (a page lacked native text) that publishes no Work and reports the affected page count.
export const pdfImportPublicationOutcomeDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }).strict(),
  z.object({ status: z.literal("pending") }).strict(),
  z.object({ status: z.literal("published"), workEntryId: z.string().min(1) }).strict(),
  z
    .object({ pagesNeedingOcr: z.number().int().positive(), status: z.literal("ocr_required") })
    .strict()
]);

export type PdfImportPublicationOutcomeDto = z.infer<typeof pdfImportPublicationOutcomeDtoSchema>;

// The full pollable view of one born-digital PDF import (#702): its #721 execution status plus its #702
// publication outcome, so a client can drive the upload -> queued -> processing -> ready/ocr/failure
// journey from a single endpoint.
export const pdfImportViewDtoSchema = z
  .object({ publication: pdfImportPublicationOutcomeDtoSchema, status: pdfImportStatusDtoSchema })
  .strict();

export type PdfImportViewDto = z.infer<typeof pdfImportViewDtoSchema>;

export function parsePdfImportBeginResultDto(value: unknown): PdfImportBeginResultDto {
  return pdfImportBeginResultDtoSchema.parse(value);
}

export function parsePdfImportViewDto(value: unknown): PdfImportViewDto {
  return pdfImportViewDtoSchema.parse(value);
}
