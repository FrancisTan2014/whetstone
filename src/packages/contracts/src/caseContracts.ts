import { z } from "zod";

// Shared DTOs for the case/map content model (#205): the authored domains -> cases -> chunk
// inventories the practice loop reads, plus the per-user, per-case mastery summary derived from the
// recall store (#189). Content (domain/case/chunk) is shared and has no owner; the mastery summary
// is computed per user and never stored on the content.

export const domainDtoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    // Frequency / importance weight in [0, 1].
    weight: z.number()
  })
  .strict();

export type DomainDto = z.infer<typeof domainDtoSchema>;

export const domainListDtoSchema = z.object({ domains: z.array(domainDtoSchema) }).strict();

export type DomainListDto = z.infer<typeof domainListDtoSchema>;

export const caseDtoSchema = z
  .object({
    communicativeFunction: z.string(),
    domainId: z.string(),
    id: z.string(),
    situation: z.string()
  })
  .strict();

export type CaseDto = z.infer<typeof caseDtoSchema>;

export const caseListDtoSchema = z.object({ cases: z.array(caseDtoSchema) }).strict();

export type CaseListDto = z.infer<typeof caseListDtoSchema>;

export const chunkDtoSchema = z
  .object({
    caseId: z.string(),
    gloss: z.string().nullable(),
    id: z.string(),
    text: z.string(),
    usageNote: z.string().nullable()
  })
  .strict();

export type ChunkDto = z.infer<typeof chunkDtoSchema>;

// The per-user, per-case mastery summary. Bucket counts always sum to `totalChunks`.
export const caseMasterySummaryDtoSchema = z
  .object({
    caseId: z.string(),
    dueChunks: z.number().int(),
    learningChunks: z.number().int(),
    masteredChunks: z.number().int(),
    newChunks: z.number().int(),
    totalChunks: z.number().int()
  })
  .strict();

export type CaseMasterySummaryDto = z.infer<typeof caseMasterySummaryDtoSchema>;

// A case's full chunk inventory plus the current user's mastery summary for it.
export const caseDetailDtoSchema = z
  .object({
    case: caseDtoSchema,
    chunks: z.array(chunkDtoSchema),
    mastery: caseMasterySummaryDtoSchema
  })
  .strict();

export type CaseDetailDto = z.infer<typeof caseDetailDtoSchema>;

export function parseDomainListDto(value: unknown): DomainListDto {
  return domainListDtoSchema.parse(value);
}

export function parseCaseListDto(value: unknown): CaseListDto {
  return caseListDtoSchema.parse(value);
}

export function parseCaseDetailDto(value: unknown): CaseDetailDto {
  return caseDetailDtoSchema.parse(value);
}

// --- Case authoring (#209) ---

// A case's lifecycle status. Mirrors the `cases.status` enum in the DB schema.
export const caseStatuses = ["needs_review", "active"] as const;

export const caseStatusSchema = z.enum(caseStatuses);

export type CaseStatus = z.infer<typeof caseStatusSchema>;

function isNonBlankCase(value: string): boolean {
  return value.trim().length > 0;
}

// A brief to author a new case into a domain the learner lacks. `domainId` is required (the case must
// be placed in an existing domain); the situation + communicative function describe the gap.
export const authorCaseRequestSchema = z
  .object({
    communicativeFunction: z
      .string()
      .refine(isNonBlankCase, { message: "communicativeFunction must be non-empty." }),
    domainId: z.string().refine(isNonBlankCase, { message: "domainId must be non-empty." }),
    situation: z.string().refine(isNonBlankCase, { message: "situation must be non-empty." })
  })
  .strict();

export type AuthorCaseRequest = z.infer<typeof authorCaseRequestSchema>;

// A review of an authored case: accept it as-is, or edit its situation / communicative function before
// accepting. Either way the case becomes `active` (curated, not blindly trusted).
export const reviewCaseRequestSchema = z
  .object({
    communicativeFunction: z
      .string()
      .refine(isNonBlankCase, { message: "communicativeFunction must be non-empty." })
      .nullish(),
    situation: z
      .string()
      .refine(isNonBlankCase, { message: "situation must be non-empty." })
      .nullish()
  })
  .strict();

export type ReviewCaseRequest = z.infer<typeof reviewCaseRequestSchema>;

// An authored (or cached) case with its chunk inventory and status. `cached` is true when the brief
// matched an already-authored case and no model call was made.
export const authoredCaseDtoSchema = z
  .object({
    cached: z.boolean(),
    case: caseDtoSchema,
    chunks: z.array(chunkDtoSchema),
    status: caseStatusSchema
  })
  .strict();

export type AuthoredCaseDto = z.infer<typeof authoredCaseDtoSchema>;

export function parseAuthorCaseRequest(value: unknown): AuthorCaseRequest {
  return authorCaseRequestSchema.parse(value);
}

export function parseReviewCaseRequest(value: unknown): ReviewCaseRequest {
  return reviewCaseRequestSchema.parse(value);
}

export function parseAuthoredCaseDto(value: unknown): AuthoredCaseDto {
  return authoredCaseDtoSchema.parse(value);
}
