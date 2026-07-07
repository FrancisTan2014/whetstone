import { z } from "zod";

import { recallCategorySchema } from "./recallContracts.js";

// Shared contracts for the Make Durable foundation (#451) and the Quick Capture review loop (#452):
// the Timeline capture, the gated proposal candidate, the user's review, the local-model proposal
// output, and the Today review card the web renders.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// How a Timeline capture was entered. `voice` joins in a later slice; v0 quick capture is `typed`.
export const captureInputModes = ["typed", "voice"] as const;

export const captureInputModeSchema = z.enum(captureInputModes);

export type CaptureInputMode = z.infer<typeof captureInputModeSchema>;

// Where a capture originated. One Timeline shape spans quick capture, diary, speech, reader, and
// writing so Diary can later be a filtered view over Timeline rather than a parallel table.
export const captureSources = ["quick_capture", "diary", "speech", "reader", "writing"] as const;

export const captureSourceSchema = z.enum(captureSources);

export type CaptureSource = z.infer<typeof captureSourceSchema>;

// The v0 proposal kinds: a reusable phrase/chunk worth remembering, a "couldn't say it" gap, or a
// recurring production pattern (a reusable fix for a repeated error — preposition, word choice, verb
// complementation, etc.).
export const proposalCandidateTypes = [
  "phrase_chunk",
  "couldnt_say_gap",
  "recurring_pattern"
] as const;

export const proposalCandidateTypeSchema = z.enum(proposalCandidateTypes);

export type ProposalCandidateType = z.infer<typeof proposalCandidateTypeSchema>;

// The candidate's workflow state: `pending` (created, not yet gated), `visible` (passed the gate and
// shown on Today), `saved` (turned into a recall item), `dismissed` (reviewed away without saving).
export const proposalCandidateStatuses = ["pending", "visible", "saved", "dismissed"] as const;

export const proposalCandidateStatusSchema = z.enum(proposalCandidateStatuses);

export type ProposalCandidateStatus = z.infer<typeof proposalCandidateStatusSchema>;

// The duplicate-check verdict recorded on a candidate. `unique` clears the gate; the rest describe how
// the candidate overlaps existing recall/candidates so later slices can suppress or merge it.
export const proposalDuplicateStatuses = [
  "unique",
  "exact_duplicate",
  "same_target_same_context",
  "same_target_new_context",
  "same_gap_better_wording",
  "related_but_distinct"
] as const;

export const proposalDuplicateStatusSchema = z.enum(proposalDuplicateStatuses);

export type ProposalDuplicateStatus = z.infer<typeof proposalDuplicateStatusSchema>;

// The user's decision on a proposal. Only `saved`/`edited_saved` create a recall item; the negatives
// record a tuning signal and create nothing.
export const proposalReviewOutcomes = [
  "saved",
  "edited_saved",
  "not_useful_now",
  "wrong_hallucinated",
  "ignored"
] as const;

export const proposalReviewOutcomeSchema = z.enum(proposalReviewOutcomes);

export type ProposalReviewOutcome = z.infer<typeof proposalReviewOutcomeSchema>;

// A free-form JSON object (a proposal payload / edited payload). The v0 prompt output schema is not
// finalized, so the payload is stored opaquely as an object rather than a fixed shape.
export const jsonObjectSchema = z.record(z.string(), z.unknown());

export type JsonObject = z.infer<typeof jsonObjectSchema>;

// A Timeline capture. `entryId` is the owning Entry (`entries.type = "timeline_entry"`); the server
// owns `createdAt`/`entryDate`. `userId` is not exposed (the server resolves the current user).
export const timelineCaptureDtoSchema = z
  .object({
    entryId: z.string(),
    createdAt: z.string(),
    entryDate: z.string(),
    inputMode: captureInputModeSchema,
    captureSource: captureSourceSchema,
    rawInputText: z.string(),
    tidiedText: z.string().nullable(),
    language: z.string().nullable(),
    rawAudioPath: z.string().nullable()
  })
  .strict();

export type TimelineCaptureDto = z.infer<typeof timelineCaptureDtoSchema>;

export const proposalCandidateDtoSchema = z
  .object({
    id: z.string(),
    timelineEntryId: z.string(),
    type: proposalCandidateTypeSchema,
    status: proposalCandidateStatusSchema,
    confidence: z.number(),
    reason: z.string(),
    evidenceQuote: z.string(),
    payload: jsonObjectSchema,
    duplicateStatus: proposalDuplicateStatusSchema,
    relatedRecallItemId: z.string().nullable(),
    noveltyReason: z.string().nullable(),
    modelName: z.string(),
    promptVersion: z.string(),
    createdAt: z.string()
  })
  .strict();

export type ProposalCandidateDto = z.infer<typeof proposalCandidateDtoSchema>;

export const proposalReviewDtoSchema = z
  .object({
    id: z.string(),
    proposalCandidateId: z.string(),
    outcome: proposalReviewOutcomeSchema,
    feedbackTags: z.array(z.string()).nullable(),
    editedPayload: jsonObjectSchema.nullable(),
    createdAt: z.string()
  })
  .strict();

export type ProposalReviewDto = z.infer<typeof proposalReviewDtoSchema>;

// The typed capture text a quick capture supplies. The owning user, ids, and timestamps are the
// server's to set, so they are not part of the request.
export const createTimelineCaptureRequestSchema = z
  .object({
    inputMode: captureInputModeSchema.default("typed"),
    captureSource: captureSourceSchema.default("quick_capture"),
    rawInputText: z.string().refine(isNonBlank, { message: "rawInputText must be non-empty." }),
    tidiedText: z
      .string()
      .refine(isNonBlank, { message: "tidiedText must be non-empty." })
      .nullish(),
    language: z.string().refine(isNonBlank, { message: "language must be non-empty." }).nullish(),
    rawAudioPath: z
      .string()
      .refine(isNonBlank, { message: "rawAudioPath must be non-empty." })
      .nullish()
  })
  .strict();

export type CreateTimelineCaptureRequest = z.infer<typeof createTimelineCaptureRequestSchema>;

export const createProposalCandidateRequestSchema = z
  .object({
    timelineEntryId: z
      .string()
      .refine(isNonBlank, { message: "timelineEntryId must be non-empty." }),
    type: proposalCandidateTypeSchema,
    status: proposalCandidateStatusSchema.default("pending"),
    confidence: z.number().min(0).max(1),
    reason: z.string().refine(isNonBlank, { message: "reason must be non-empty." }),
    evidenceQuote: z.string().refine(isNonBlank, { message: "evidenceQuote must be non-empty." }),
    payload: jsonObjectSchema,
    duplicateStatus: proposalDuplicateStatusSchema.default("unique"),
    relatedRecallItemId: z
      .string()
      .refine(isNonBlank, { message: "relatedRecallItemId must be non-empty." })
      .nullish(),
    noveltyReason: z
      .string()
      .refine(isNonBlank, { message: "noveltyReason must be non-empty." })
      .nullish(),
    modelName: z.string().refine(isNonBlank, { message: "modelName must be non-empty." }),
    promptVersion: z.string().refine(isNonBlank, { message: "promptVersion must be non-empty." })
  })
  .strict();

export type CreateProposalCandidateRequest = z.infer<typeof createProposalCandidateRequestSchema>;

export const recordProposalReviewRequestSchema = z
  .object({
    proposalCandidateId: z
      .string()
      .refine(isNonBlank, { message: "proposalCandidateId must be non-empty." }),
    outcome: proposalReviewOutcomeSchema,
    feedbackTags: z
      .array(z.string().refine(isNonBlank, { message: "feedbackTag must be non-empty." }))
      .nullish(),
    editedPayload: jsonObjectSchema.nullish()
  })
  .strict();

export type RecordProposalReviewRequest = z.infer<typeof recordProposalReviewRequestSchema>;

export function parseTimelineCaptureDto(value: unknown): TimelineCaptureDto {
  return timelineCaptureDtoSchema.parse(value);
}

export function parseProposalCandidateDto(value: unknown): ProposalCandidateDto {
  return proposalCandidateDtoSchema.parse(value);
}

export function parseProposalReviewDto(value: unknown): ProposalReviewDto {
  return proposalReviewDtoSchema.parse(value);
}

export function parseCreateTimelineCaptureRequest(value: unknown): CreateTimelineCaptureRequest {
  return createTimelineCaptureRequestSchema.parse(value);
}

export function parseCreateProposalCandidateRequest(
  value: unknown
): CreateProposalCandidateRequest {
  return createProposalCandidateRequestSchema.parse(value);
}

export function parseRecordProposalReviewRequest(value: unknown): RecordProposalReviewRequest {
  return recordProposalReviewRequestSchema.parse(value);
}

// ---------------------------------------------------------------------------
// Quick Capture review loop (#452)
// ---------------------------------------------------------------------------

// A Quick Capture: the raw text the learner submits from the Today capture surface. `inputMode`
// distinguishes a typed capture from a voice one (the transcript is submitted as `text`); it defaults
// to `typed` so an omitting caller stays typed. The owning user, ids, and timestamps are the server's
// to set.
export const quickCaptureRequestSchema = z
  .object({
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." }),
    inputMode: captureInputModeSchema.default("typed")
  })
  .strict();

export type QuickCaptureRequest = z.infer<typeof quickCaptureRequestSchema>;

// The proposed recall payload a candidate carries: the durable item the learner would save. `target`
// is the phrase/pattern to remember; `cue` is the retrieval prompt; `useContext` is when/where to use
// it; `explanation` is an optional gloss; `category` is the one broad bucket; `tags` are optional narrow
// tags. This is the shape of `proposal_candidates.payload_json` and the source of the review card.
export const proposalPayloadSchema = z
  .object({
    target: z.string().refine(isNonBlank, { message: "target must be non-empty." }),
    cue: z.string().refine(isNonBlank, { message: "cue must be non-empty." }),
    useContext: z.string().refine(isNonBlank, { message: "useContext must be non-empty." }),
    explanation: z
      .string()
      .refine(isNonBlank, { message: "explanation must be non-empty." })
      .nullish(),
    category: recallCategorySchema,
    tags: z.array(z.string().refine(isNonBlank, { message: "tag must be non-empty." })).nullish()
  })
  .strict();

export type ProposalPayload = z.infer<typeof proposalPayloadSchema>;

// One candidate as emitted by the local proposal model. `evidenceQuote` must be a faithful quote from
// the capture (enforced by the gate); `duplicateCheckQuery` is an optional retrieval hint. The gate and
// dedup run over this before it is ever shown.
export const proposalGenerationCandidateSchema = z
  .object({
    type: proposalCandidateTypeSchema,
    confidence: z.number().min(0).max(1),
    reason: z.string().refine(isNonBlank, { message: "reason must be non-empty." }),
    evidenceQuote: z.string().refine(isNonBlank, { message: "evidenceQuote must be non-empty." }),
    duplicateCheckQuery: z
      .string()
      .refine(isNonBlank, { message: "duplicateCheckQuery must be non-empty." })
      .nullish(),
    payload: proposalPayloadSchema
  })
  .strict();

export type ProposalGenerationCandidate = z.infer<typeof proposalGenerationCandidateSchema>;

// The whole proposal-model output: zero or one candidate. More than one is invalid output (the prompt
// asks for at most one), so it is rejected and no card is shown.
export const proposalGenerationSchema = z
  .object({
    candidates: z.array(proposalGenerationCandidateSchema).max(1)
  })
  .strict();

export type ProposalGeneration = z.infer<typeof proposalGenerationSchema>;

// The Today review card: everything the web needs to render one Make Durable proposal and act on it.
// Derived from the visible candidate + its payload; `tags` is always an array (possibly empty).
export const makeDurableCardDtoSchema = z
  .object({
    proposalCandidateId: z.string(),
    timelineEntryId: z.string(),
    type: proposalCandidateTypeSchema,
    target: z.string(),
    cue: z.string(),
    useContext: z.string(),
    reason: z.string(),
    category: recallCategorySchema,
    tags: z.array(z.string())
  })
  .strict();

export type MakeDurableCardDto = z.infer<typeof makeDurableCardDtoSchema>;

export const makeDurableCardListDtoSchema = z
  .object({ cards: z.array(makeDurableCardDtoSchema) })
  .strict();

export type MakeDurableCardListDto = z.infer<typeof makeDurableCardListDtoSchema>;

// The Quick Capture response: the Timeline entry (always saved) and the review card IF a proposal
// passed the gate/dedup (null when the model was unavailable, slow, invalid, gated out, or a duplicate).
export const quickCaptureResultDtoSchema = z
  .object({
    timelineEntry: timelineCaptureDtoSchema,
    card: makeDurableCardDtoSchema.nullable()
  })
  .strict();

export type QuickCaptureResultDto = z.infer<typeof quickCaptureResultDtoSchema>;

// The bounded Make Durable backfill result (#456): the one review card this run surfaced (null when the
// scan found no gated-in high-value proposal, or Today already holds a card so the proposal was held),
// plus how many prior Timeline entries the model actually evaluated this run (0 when the model was
// unavailable, so history is unchanged).
export const backfillResultDtoSchema = z
  .object({
    card: makeDurableCardDtoSchema.nullable(),
    scannedCount: z.number().int().nonnegative()
  })
  .strict();

export type BackfillResultDto = z.infer<typeof backfillResultDtoSchema>;

// The review-card action body: the outcome, plus (for Edit + Save) the edited payload and optional
// feedback tags. The candidate id comes from the route path.
export const reviewProposalRequestSchema = z
  .object({
    outcome: proposalReviewOutcomeSchema,
    editedPayload: proposalPayloadSchema.nullish(),
    feedbackTags: z
      .array(z.string().refine(isNonBlank, { message: "feedbackTag must be non-empty." }))
      .nullish()
  })
  .strict()
  .refine((data) => data.outcome !== "edited_saved" || (data.editedPayload ?? null) !== null, {
    message: "editedPayload is required when outcome is edited_saved.",
    path: ["editedPayload"]
  });

export type ReviewProposalRequest = z.infer<typeof reviewProposalRequestSchema>;

export function parseQuickCaptureRequest(value: unknown): QuickCaptureRequest {
  return quickCaptureRequestSchema.parse(value);
}

export function parseProposalGeneration(value: unknown): ProposalGeneration {
  return proposalGenerationSchema.parse(value);
}

export function parseProposalPayload(value: unknown): ProposalPayload {
  return proposalPayloadSchema.parse(value);
}

export function parseMakeDurableCardDto(value: unknown): MakeDurableCardDto {
  return makeDurableCardDtoSchema.parse(value);
}

export function parseMakeDurableCardListDto(value: unknown): MakeDurableCardListDto {
  return makeDurableCardListDtoSchema.parse(value);
}

export function parseQuickCaptureResultDto(value: unknown): QuickCaptureResultDto {
  return quickCaptureResultDtoSchema.parse(value);
}

export function parseBackfillResultDto(value: unknown): BackfillResultDto {
  return backfillResultDtoSchema.parse(value);
}

export function parseReviewProposalRequest(value: unknown): ReviewProposalRequest {
  return reviewProposalRequestSchema.parse(value);
}
