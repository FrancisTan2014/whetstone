import { z } from "zod";

import { productionJudgementSchema } from "./coachContracts.js";
import { errorCategorySchema } from "./learnerContracts.js";

// Shared shapes for the spoken practice session (#211): the session plan (cues), the per-turn request
// and result, the STT transcribe boundary, and the end-of-session summary. The session runs over the
// coach (#206) and speech (#207) seams, so every value crossing the API is described here.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// One cue: the situation to elicit (English/scene — never L1) and the native target the learner should
// produce, plus a soft per-cue timer for mild time pressure. `target` is the answer, revealed only in
// feedback, not shown as the prompt.
export const sessionCueDtoSchema = z
  .object({
    caseId: z.string(),
    chunkId: z.string(),
    communicativeFunction: z.string(),
    situation: z.string(),
    target: z.string(),
    timerSeconds: z.number().int().positive()
  })
  .strict();

export type SessionCueDto = z.infer<typeof sessionCueDtoSchema>;

export const sessionPlanDtoSchema = z.object({ cues: z.array(sessionCueDtoSchema) }).strict();

export type SessionPlanDto = z.infer<typeof sessionPlanDtoSchema>;

// What the learner produced: either spoken (an audio file the STT seam transcribes) or typed (the
// fallback when there is no mic).
export const productionInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      audioPath: z.string().refine(isNonBlank, { message: "audioPath must be non-empty." }),
      kind: z.literal("spoken")
    })
    .strict(),
  z.object({ kind: z.literal("typed"), transcript: z.string() }).strict()
]);

export type ProductionInput = z.infer<typeof productionInputSchema>;

export const submitTurnRequestSchema = z
  .object({
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }),
    production: productionInputSchema
  })
  .strict();

export type SubmitTurnRequest = z.infer<typeof submitTurnRequestSchema>;

// The turn result: the grade, the native target + the coach's judgement (compact constructive
// feedback), the transcript that was judged, the deposited mistake category, and the item's next due.
export const turnResultDtoSchema = z
  .object({
    errorCategory: errorCategorySchema.nullable(),
    grade: z.number().int().min(0).max(5),
    judgement: productionJudgementSchema,
    nextDueAt: z.string(),
    target: z.string(),
    transcript: z.string()
  })
  .strict();

export type TurnResultDto = z.infer<typeof turnResultDtoSchema>;

export const transcribeRequestSchema = z
  .object({
    audioPath: z.string().refine(isNonBlank, { message: "audioPath must be non-empty." })
  })
  .strict();

export type TranscribeRequest = z.infer<typeof transcribeRequestSchema>;

export const transcribeResultDtoSchema = z.object({ transcript: z.string() }).strict();

export type TranscribeResultDto = z.infer<typeof transcribeResultDtoSchema>;

// One turn the client reports at session end (the grade + mistake category it was told).
export const sessionTurnRecordSchema = z
  .object({
    errorCategory: errorCategorySchema.nullable(),
    grade: z.number().int().min(0).max(5)
  })
  .strict();

export type SessionTurnRecord = z.infer<typeof sessionTurnRecordSchema>;

export const endSessionRequestSchema = z
  .object({ turns: z.array(sessionTurnRecordSchema) })
  .strict();

export type EndSessionRequest = z.infer<typeof endSessionRequestSchema>;

export const sessionErrorCountDtoSchema = z
  .object({ category: errorCategorySchema, count: z.number().int().positive() })
  .strict();

export const sessionSummaryDtoSchema = z
  .object({
    averageGrade: z.number(),
    errorCounts: z.array(sessionErrorCountDtoSchema),
    strongTurns: z.number().int(),
    turnCount: z.number().int()
  })
  .strict();

export type SessionSummaryDto = z.infer<typeof sessionSummaryDtoSchema>;

export function parseSubmitTurnRequest(value: unknown): SubmitTurnRequest {
  return submitTurnRequestSchema.parse(value);
}

export function parseTranscribeRequest(value: unknown): TranscribeRequest {
  return transcribeRequestSchema.parse(value);
}

export function parseEndSessionRequest(value: unknown): EndSessionRequest {
  return endSessionRequestSchema.parse(value);
}

export function parseSessionPlanDto(value: unknown): SessionPlanDto {
  return sessionPlanDtoSchema.parse(value);
}

export function parseTurnResultDto(value: unknown): TurnResultDto {
  return turnResultDtoSchema.parse(value);
}

export function parseSessionSummaryDto(value: unknown): SessionSummaryDto {
  return sessionSummaryDtoSchema.parse(value);
}
