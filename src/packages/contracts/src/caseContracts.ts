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
