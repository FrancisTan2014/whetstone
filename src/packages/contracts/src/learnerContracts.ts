import { z } from "zod";

// Shared, Zod-validated shapes for the learner model (#208): the categorized error-pattern store, the
// rolling profile, and the bounded `compileContext` slice the loop and coach consume. Enum literals
// mirror `@whetstone/domain` (`learnerModel.ts` / `caseMastery.ts`); keep them in sync.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export const errorCategories = [
  "article_drop",
  "l1_calque",
  "wrong_collocation",
  "register",
  "word_order",
  "tense_aspect",
  "other"
] as const;

export const errorCategorySchema = z.enum(errorCategories);

export type ErrorCategory = z.infer<typeof errorCategorySchema>;

export const proficiencyLevels = ["beginner", "elementary", "intermediate", "advanced"] as const;

export const proficiencyLevelSchema = z.enum(proficiencyLevels);

export type ProficiencyLevel = z.infer<typeof proficiencyLevelSchema>;

export const chunkMasteryStatuses = ["new", "learning", "due", "mastered"] as const;

export const chunkMasteryStatusSchema = z.enum(chunkMasteryStatuses);

// One categorized recurring error for a user, with how often (`count`) and how recently (`lastSeenAt`)
// it has occurred.
export const errorPatternDtoSchema = z
  .object({
    category: errorCategorySchema,
    count: z.number().int().positive(),
    lastSeenAt: z.string()
  })
  .strict();

export type ErrorPatternDto = z.infer<typeof errorPatternDtoSchema>;

// One deposited turn outcome: the grade, the chunk it was about (if any), and the diagnosed error
// category (if any).
export const turnOutcomeDtoSchema = z
  .object({
    chunkId: z.string().nullable(),
    errorCategory: errorCategorySchema.nullable(),
    grade: z.number().int().min(0).max(5),
    recordedAt: z.string()
  })
  .strict();

export type TurnOutcomeDto = z.infer<typeof turnOutcomeDtoSchema>;

// What the loop deposits after a turn: the grade, and optionally the chunk practised and the error
// category diagnosed. The server stamps the user and time.
export const depositTurnOutcomeRequestSchema = z
  .object({
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }).nullish(),
    errorCategory: errorCategorySchema.nullish(),
    grade: z.number().int().min(0).max(5)
  })
  .strict();

export type DepositTurnOutcomeRequest = z.infer<typeof depositTurnOutcomeRequestSchema>;

// A candidate chunk ranked for practice by gap x frequency.
export const rankedChunkDtoSchema = z
  .object({
    caseId: z.string(),
    chunkId: z.string(),
    domainId: z.string(),
    frequency: z.number(),
    gap: z.number(),
    score: z.number(),
    status: chunkMasteryStatusSchema
  })
  .strict();

export type RankedChunkDto = z.infer<typeof rankedChunkDtoSchema>;

// The rolling learner profile: a small, periodically-distilled summary.
export const learnerProfileDtoSchema = z
  .object({
    focus: z.string(),
    level: proficiencyLevelSchema,
    strengths: z.array(z.string()),
    summary: z.string(),
    updatedAt: z.string(),
    weaknesses: z.array(z.string())
  })
  .strict();

export type LearnerProfileDto = z.infer<typeof learnerProfileDtoSchema>;

// The bounded context compiled for each coaching call: the rolling profile, the top gap x frequency
// chunks, the relevant errors, and the recent outcomes. Every list is capped, so the slice stays
// roughly constant in size however long the learner's history grows.
export const compiledLearnerContextDtoSchema = z
  .object({
    profile: learnerProfileDtoSchema.nullable(),
    rankedChunks: z.array(rankedChunkDtoSchema),
    recentOutcomes: z.array(turnOutcomeDtoSchema),
    relevantErrors: z.array(errorPatternDtoSchema)
  })
  .strict();

export type CompiledLearnerContextDto = z.infer<typeof compiledLearnerContextDtoSchema>;

export function parseDepositTurnOutcomeRequest(value: unknown): DepositTurnOutcomeRequest {
  return depositTurnOutcomeRequestSchema.parse(value);
}

export function parseLearnerProfileDto(value: unknown): LearnerProfileDto {
  return learnerProfileDtoSchema.parse(value);
}

export function parseCompiledLearnerContextDto(value: unknown): CompiledLearnerContextDto {
  return compiledLearnerContextDtoSchema.parse(value);
}
