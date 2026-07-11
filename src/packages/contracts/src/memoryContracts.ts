import { captureSources, promptLifecycles } from "@whetstone/domain";
import { z } from "zod";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export const captureSourceSchema = z.enum(captureSources);

export const promptLifecycleSchema = z.enum(promptLifecycles);

// The FSRS card state a scheduled prompt carries (#595). ISO-8601 `due`/`lastReviewedAt` (the latter null
// until the first review); the rest are the FSRS card fields the scheduler round-trips. Structurally equal
// to the domain `ReviewState`.
export const reviewStateDtoSchema = z
  .object({
    due: z.string().datetime(),
    stability: z.number(),
    difficulty: z.number(),
    elapsedDays: z.number().int(),
    scheduledDays: z.number().int(),
    learningSteps: z.number().int(),
    reps: z.number().int(),
    lapses: z.number().int(),
    state: z.enum(["new", "learning", "review", "relearning"]),
    lastReviewedAt: z.string().datetime().nullable()
  })
  .strict();

export type ReviewStateDto = z.infer<typeof reviewStateDtoSchema>;

export const ratingSchema = z.enum(["again", "hard", "good", "easy"]);

// A Memory note DTO: the durable retention target's identity, how it was captured, its readable body
// projection, and optional provenance (the source Entry it was derived from).
export const memoryNoteDtoSchema = z
  .object({
    noteId: z.string(),
    captureSource: captureSourceSchema,
    bodyText: z.string(),
    derivedFromEntryId: z.string().nullable()
  })
  .strict();

export type MemoryNoteDto = z.infer<typeof memoryNoteDtoSchema>;

// A Memory note as the Memory list/search surface shows one row (#573): the durable knowledge fragment
// (`bodyText`), how it was captured, and a jargon-free rollup of its prompts — total count, how many are
// drafts (unscheduled, awaiting an answer) vs scheduled, how many are due now, and when the soonest one
// is next due (null when the note has no scheduled prompt). The learner never sees storage internals; the
// row reads as "fragment · source · N prompts · draft/due state".
export const memoryNoteSummaryDtoSchema = z
  .object({
    noteId: z.string(),
    captureSource: captureSourceSchema,
    bodyText: z.string(),
    promptCount: z.number().int().nonnegative(),
    draftCount: z.number().int().nonnegative(),
    scheduledCount: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    nextDueAt: z.string().datetime().nullable()
  })
  .strict();

export type MemoryNoteSummaryDto = z.infer<typeof memoryNoteSummaryDtoSchema>;

export const memoryNoteListDtoSchema = z
  .object({ items: z.array(memoryNoteSummaryDtoSchema) })
  .strict();

export type MemoryNoteListDto = z.infer<typeof memoryNoteListDtoSchema>;

// A Memory prompt DTO in full (used by the MCP get/search/deposit surfaces): it may be a `draft`
// (no card, no revealable answer) or `scheduled` (both present).
export const memoryPromptDtoSchema = z
  .object({
    promptId: z.string(),
    noteId: z.string(),
    lifecycle: promptLifecycleSchema,
    cueText: z.string(),
    answerText: z.string().nullable(),
    chunkId: z.string().nullable(),
    review: reviewStateDtoSchema.nullable()
  })
  .strict();

export type MemoryPromptDto = z.infer<typeof memoryPromptDtoSchema>;

// A due Memory prompt as the review surface shows it: a scheduled prompt always carries a revealable
// answer and a card, so `answerText` and `review` are non-null here.
export const memoryPromptCardDtoSchema = z
  .object({
    promptId: z.string(),
    noteId: z.string(),
    cueText: z.string(),
    answerText: z.string(),
    chunkId: z.string().nullable(),
    review: reviewStateDtoSchema
  })
  .strict();

export type MemoryPromptCardDto = z.infer<typeof memoryPromptCardDtoSchema>;

export const memoryPromptCardListDtoSchema = z
  .object({ items: z.array(memoryPromptCardDtoSchema) })
  .strict();

export type MemoryPromptCardListDto = z.infer<typeof memoryPromptCardListDtoSchema>;

// The atomic result of depositing a Memory: the note plus every prompt created under it.
export const memoryDepositDtoSchema = z
  .object({ note: memoryNoteDtoSchema, prompts: z.array(memoryPromptDtoSchema) })
  .strict();

export type MemoryDepositDto = z.infer<typeof memoryDepositDtoSchema>;

// The full detail of one Memory note (#573): the note plus every prompt hanging off it (draft or
// scheduled), for the Memory detail/edit surface. Structurally the same as a deposit result, but named
// for its read semantics.
export const memoryNoteDetailDtoSchema = z
  .object({ note: memoryNoteDtoSchema, prompts: z.array(memoryPromptDtoSchema) })
  .strict();

export type MemoryNoteDetailDto = z.infer<typeof memoryNoteDetailDtoSchema>;

// An offline-dictionary suggestion for a bare term (#573): the term the learner typed and a suggested
// answer to prefill, or null when no bundled dictionary knows it. The learner confirms or edits before
// saving; an unknown term is saved as an unscheduled draft, never blocked.
export const memoryGlossSuggestionDtoSchema = z
  .object({ term: z.string(), suggestion: z.string().nullable() })
  .strict();

export type MemoryGlossSuggestionDto = z.infer<typeof memoryGlossSuggestionDtoSchema>;

// Edit a Memory note's durable body (#573). Only the readable body changes; the capture source is
// structured provenance and is never rewritten by an edit.
export const editMemoryNoteRequestSchema = z
  .object({ noteText: z.string().refine(isNonBlank, { message: "noteText must be non-empty." }) })
  .strict();

export type EditMemoryNoteRequest = z.infer<typeof editMemoryNoteRequestSchema>;

// Edit one prompt's cue/answer (#573). Reconciling the edit with the schedule (keep the card, seed a new
// one, or revert to a draft) is the server's job via the pure domain rule — editing content never
// silently resets review history.
export const editMemoryPromptRequestSchema = z
  .object({
    cueText: z.string().refine(isNonBlank, { message: "cueText must be non-empty." }),
    answerText: z
      .string()
      .refine(isNonBlank, { message: "answerText must be non-empty." })
      .nullish()
  })
  .strict();

export type EditMemoryPromptRequest = z.infer<typeof editMemoryPromptRequestSchema>;

// Add one additional retrieval direction to an existing note (#573): the same shape as a deposit prompt,
// so a bare word may request an offline-dictionary suggestion and an answerless direction saves as a
// draft. Defined below, after `memoryPromptInputSchema`, to avoid referencing it before initialization.

// One retrieval direction supplied when depositing a Memory. `cueText` is the prompt shown first;
// `answerText` is what to reveal and check against — absent means the producer had no revealable answer.
// `glossTerm` optionally asks the offline dictionary to SUGGEST an answer (it never blocks the write): if
// the dictionary knows the term the prompt is scheduled, otherwise it is saved as an unscheduled draft.
// `chunkId` optionally links the direction to a practice chunk so mastery keeps deriving from FSRS state.
export const memoryPromptInputSchema = z
  .object({
    cueText: z.string().refine(isNonBlank, { message: "cueText must be non-empty." }),
    answerText: z
      .string()
      .refine(isNonBlank, { message: "answerText must be non-empty." })
      .nullish(),
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }).nullish(),
    glossTerm: z.string().refine(isNonBlank, { message: "glossTerm must be non-empty." }).nullish()
  })
  .strict();

export type MemoryPromptInput = z.infer<typeof memoryPromptInputSchema>;

// Add one additional retrieval direction to an existing note (#573): the same shape as a deposit prompt.
export const addMemoryPromptRequestSchema = memoryPromptInputSchema;

export type AddMemoryPromptRequest = z.infer<typeof addMemoryPromptRequestSchema>;

// Deposit a Memory: one note (its durable body + capture source + optional provenance) and at least one
// retrieval prompt. The owning user is resolved by the server, never supplied here.
export const depositMemoryRequestSchema = z
  .object({
    captureSource: captureSourceSchema,
    noteText: z.string().refine(isNonBlank, { message: "noteText must be non-empty." }),
    derivedFromEntryId: z
      .string()
      .refine(isNonBlank, { message: "derivedFromEntryId must be non-empty." })
      .nullish(),
    prompts: z
      .array(memoryPromptInputSchema)
      .min(1, { message: "at least one prompt is required." })
  })
  .strict();

export type DepositMemoryRequest = z.infer<typeof depositMemoryRequestSchema>;

// Record a review: the learner's (or an LLM's) four-button FSRS rating. The prompt, user, and time are
// resolved by the server, not part of the body.
export const recordMemoryReviewRequestSchema = z.object({ rating: ratingSchema }).strict();

export type RecordMemoryReviewRequest = z.infer<typeof recordMemoryReviewRequestSchema>;

// MCP tool inputs (#190/#595). They live here so the MCP layer validates with the shared contracts.
export const listDuePromptsToolInputSchema = z
  .object({ limit: z.number().int().positive().optional() })
  .strict();

export type ListDuePromptsToolInput = z.infer<typeof listDuePromptsToolInputSchema>;

export const recordReviewToolInputSchema = z
  .object({
    rating: ratingSchema,
    promptId: z.string().refine(isNonBlank, { message: "promptId must be non-empty." })
  })
  .strict();

export type RecordReviewToolInput = z.infer<typeof recordReviewToolInputSchema>;

export const searchMemoryToolInputSchema = z.object({ query: z.string() }).strict();

export type SearchMemoryToolInput = z.infer<typeof searchMemoryToolInputSchema>;

export const getMemoryPromptToolInputSchema = z
  .object({ promptId: z.string().refine(isNonBlank, { message: "promptId must be non-empty." }) })
  .strict();

export type GetMemoryPromptToolInput = z.infer<typeof getMemoryPromptToolInputSchema>;

export function parseDepositMemoryRequest(value: unknown): DepositMemoryRequest {
  return depositMemoryRequestSchema.parse(value);
}

export function parseRecordMemoryReviewRequest(value: unknown): RecordMemoryReviewRequest {
  return recordMemoryReviewRequestSchema.parse(value);
}

export function parseMemoryPromptCardDto(value: unknown): MemoryPromptCardDto {
  return memoryPromptCardDtoSchema.parse(value);
}

export function parseMemoryPromptCardListDto(value: unknown): MemoryPromptCardListDto {
  return memoryPromptCardListDtoSchema.parse(value);
}

export function parseMemoryPromptDto(value: unknown): MemoryPromptDto {
  return memoryPromptDtoSchema.parse(value);
}

export function parseMemoryDepositDto(value: unknown): MemoryDepositDto {
  return memoryDepositDtoSchema.parse(value);
}

export function parseMemoryNoteSummaryDto(value: unknown): MemoryNoteSummaryDto {
  return memoryNoteSummaryDtoSchema.parse(value);
}

export function parseMemoryNoteListDto(value: unknown): MemoryNoteListDto {
  return memoryNoteListDtoSchema.parse(value);
}

export function parseMemoryNoteDetailDto(value: unknown): MemoryNoteDetailDto {
  return memoryNoteDetailDtoSchema.parse(value);
}

export function parseMemoryGlossSuggestionDto(value: unknown): MemoryGlossSuggestionDto {
  return memoryGlossSuggestionDtoSchema.parse(value);
}

export function parseEditMemoryNoteRequest(value: unknown): EditMemoryNoteRequest {
  return editMemoryNoteRequestSchema.parse(value);
}

export function parseEditMemoryPromptRequest(value: unknown): EditMemoryPromptRequest {
  return editMemoryPromptRequestSchema.parse(value);
}

export function parseAddMemoryPromptRequest(value: unknown): AddMemoryPromptRequest {
  return addMemoryPromptRequestSchema.parse(value);
}
