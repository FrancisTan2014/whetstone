import { z } from "zod";

import { productionJudgementSchema } from "./coachContracts.js";
import { errorCategorySchema } from "./learnerContracts.js";
import { transcribedWordSchema } from "./speechContracts.js";

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
// The content type the web posts recorded audio with to the transcribe (STT) endpoint.
export const audioContentType = "application/octet-stream";

// A turn submits the transcript that was produced — either typed (the fallback) or recognized by the
// STT seam (#207) from a recorded utterance via the transcribe endpoint. Spoken production therefore
// always passes through the STT seam before the turn is submitted.
export const submitTurnRequestSchema = z
  .object({
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }),
    transcript: z.string()
  })
  .strict();

export type SubmitTurnRequest = z.infer<typeof submitTurnRequestSchema>;

// A conversational turn over the coach seam (#220): the case the call is set in and the learner's latest
// transcript. The transcript may be empty — that is a breakdown (the learner went quiet / unintelligible)
// the coach repairs. The server reconstructs the conversation history from the persisted exchange, so the
// client only sends the latest line. No per-turn grading happens here (that is the end-of-round job).
export const coachSayRequestSchema = z
  .object({
    caseId: z.string().refine(isNonBlank, { message: "caseId must be non-empty." }),
    transcript: z.string()
  })
  .strict();

export type CoachSayRequest = z.infer<typeof coachSayRequestSchema>;

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

export const transcribeResultDtoSchema = z
  .object({ transcript: z.string(), words: z.array(transcribedWordSchema) })
  .strict();

export type TranscribeResultDto = z.infer<typeof transcribeResultDtoSchema>;

// One turn the client reports at session end (the grade + mistake category it was told).
export const sessionTurnRecordSchema = z
  .object({
    errorCategory: errorCategorySchema.nullable(),
    grade: z.number().int().min(0).max(5)
  })
  .strict();

export type SessionTurnRecord = z.infer<typeof sessionTurnRecordSchema>;

// Ending a round (#222): the case the call was set in plus the round's STT word-timings. The server
// assembles the rest of the round record (full transcript, target chunks, compiled context) from
// persisted state, runs the one analysis pass, deposits the durable trace, and returns the debrief.
export const endSessionRequestSchema = z
  .object({
    caseId: z.string().refine(isNonBlank, { message: "caseId must be non-empty." }),
    words: z.array(transcribedWordSchema)
  })
  .strict();

export type EndSessionRequest = z.infer<typeof endSessionRequestSchema>;

// One debrief moment: a high-value correction shown as said -> native with a short why.
export const debriefMomentDtoSchema = z
  .object({ native: z.string(), said: z.string(), why: z.string() })
  .strict();

export type DebriefMomentDto = z.infer<typeof debriefMomentDtoSchema>;

// One item now scheduled for recall after the round, with when it is next due.
export const debriefDueDtoSchema = z.object({ dueAt: z.string(), text: z.string() }).strict();

export type DebriefDueDto = z.infer<typeof debriefDueDtoSchema>;

// The compact end-of-round debrief: a line of encouragement, the 2-3 moments that matter, the one
// native upgrade to carry, the wins, and what is now due to recall. Calm, not a wall of corrections.
export const debriefDtoSchema = z
  .object({
    due: z.array(debriefDueDtoSchema),
    encouragement: z.string(),
    moments: z.array(debriefMomentDtoSchema),
    upgrade: z.object({ native: z.string(), said: z.string() }).strict(),
    wins: z.array(z.string())
  })
  .strict();

export type DebriefDto = z.infer<typeof debriefDtoSchema>;

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

export function parseCoachSayRequest(value: unknown): CoachSayRequest {
  return coachSayRequestSchema.parse(value);
}

export function parseEndSessionRequest(value: unknown): EndSessionRequest {
  return endSessionRequestSchema.parse(value);
}

export function parseDebriefDto(value: unknown): DebriefDto {
  return debriefDtoSchema.parse(value);
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
