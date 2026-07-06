import { z } from "zod";

// Shared contracts for the Make Durable foundation (#451): the Timeline capture, the gated proposal
// candidate, and the user's review of a proposal. These are the data-boundary schemas the server
// commands validate with and return; there is no HTTP endpoint in this slice.

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

// The two v0 proposal kinds: a reusable phrase/chunk worth remembering, or a "couldn't say it" gap.
export const proposalCandidateTypes = ["phrase_chunk", "couldnt_say_gap"] as const;

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
