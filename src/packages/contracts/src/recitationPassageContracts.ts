import {
  passageAnchorStatuses,
  recitationCueStrengths,
  recitationIntroductionReasons,
  recitationSupportLevels
} from "@whetstone/domain";
import { z } from "zod";

import { recitationPhaseDtoSchema } from "./recitationContracts.js";

// Shared, Zod-validated shapes for recitation passage practice (#578): a learner divides a recitation
// Work into contiguous passages, edits the boundaries (split / merge), practises the next due passage
// from a restrained cue, reveals the exact source, and self-assesses. Every value crossing the passage
// API is described here; the server validates once at the boundary and trusts the typed data inward.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

const nonBlankString = z.string().refine(isNonBlank, { message: "must be non-empty." });

// The four-button FSRS rating a self-assessment maps to (#572), and the restrained cue a learner
// attempted from — both reused from the domain vocabulary so DTO and domain never drift.
export const recitationReviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export type RecitationReviewRating = z.infer<typeof recitationReviewRatingSchema>;

export const recitationCueStrengthDtoSchema = z.enum(recitationCueStrengths);

export type RecitationCueStrengthDto = z.infer<typeof recitationCueStrengthDtoSchema>;

export const recitationAnchorStatusDtoSchema = z.enum(passageAnchorStatuses);

export type RecitationAnchorStatusDto = z.infer<typeof recitationAnchorStatusDtoSchema>;

// The learner-chosen visual support level a due passage opens at (#579): how much of the target is
// shown before an attempt. Reused from the domain vocabulary so DTO and projection never drift.
export const recitationSupportLevelDtoSchema = z.enum(recitationSupportLevels);

export type RecitationSupportLevelDto = z.infer<typeof recitationSupportLevelDtoSchema>;

// A persisted passage with its source range and its lifecycle (#605). A passage is either **queued**
// (introduced, awaiting activation: no schedule yet) or **active** (a scheduled FSRS card), modelled as
// a discriminated union on `status` so an unscheduled passage can never be mistaken for a card. The
// shared fields (source range, order, review count) are on both; the FSRS summary (`dueAt`, `reps`,
// `lapses`, `lastReviewedAt`) exists only on the active variant. Offsets index a block's plaintext;
// equal block ids mean a single-block passage. `reviewCount` is how many self-assessments have been
// recorded (always 0 while queued).
const recitationPassageBaseShape = {
  anchorStatus: recitationAnchorStatusDtoSchema,
  endBlockEntryId: z.string(),
  endOffset: z.number().int().nonnegative(),
  entryId: z.string(),
  orderIndex: z.number().int().nonnegative(),
  planEntryId: z.string(),
  reviewCount: z.number().int().nonnegative(),
  sourceText: z.string(),
  startBlockEntryId: z.string(),
  startOffset: z.number().int().nonnegative()
} as const;

export const queuedRecitationPassageDtoSchema = z
  .object({ ...recitationPassageBaseShape, status: z.literal("queued") })
  .strict();

export type QueuedRecitationPassageDto = z.infer<typeof queuedRecitationPassageDtoSchema>;

export const activeRecitationPassageDtoSchema = z
  .object({
    ...recitationPassageBaseShape,
    dueAt: z.string(),
    lapses: z.number().int().nonnegative(),
    lastReviewedAt: z.string().nullable(),
    reps: z.number().int().nonnegative(),
    status: z.literal("active")
  })
  .strict();

export type ActiveRecitationPassageDto = z.infer<typeof activeRecitationPassageDtoSchema>;

export const recitationPassageDtoSchema = z.discriminatedUnion("status", [
  queuedRecitationPassageDtoSchema,
  activeRecitationPassageDtoSchema
]);

export type RecitationPassageDto = z.infer<typeof recitationPassageDtoSchema>;

export const recitationPassageListDtoSchema = z
  .object({ passages: z.array(recitationPassageDtoSchema), planEntryId: z.string() })
  .strict();

export type RecitationPassageListDto = z.infer<typeof recitationPassageListDtoSchema>;

// The server-computed new-passage introduction status for one plan (#607). Learning introduction is
// explicit and paced: passages seed queued, and a learner introduces the next one at a time, capped per
// local day and only when no introduced passage is still due. `dueCount` is how many introduced passages
// are due/overdue; `introducedToday` is how many were introduced on the learner's current local day out
// of `dailyCap`, with `remainingCapacity` the paced remainder; `anyIntroduced` lets the UI label the
// action "Start first passage" vs "New passage"; `newPassageAvailable` + `reason` are the single decision
// (available only when learning, nothing due, under the cap, and a queued passage remains); `nextQueued`
// previews the lowest-order queued passage (null when none remains).
export const recitationIntroductionNextQueuedSchema = z
  .object({
    entryId: z.string(),
    orderIndex: z.number().int().nonnegative(),
    sourceText: z.string()
  })
  .strict();

export type RecitationIntroductionNextQueued = z.infer<
  typeof recitationIntroductionNextQueuedSchema
>;

export const recitationIntroductionStatusDtoSchema = z
  .object({
    anyIntroduced: z.boolean(),
    dailyCap: z.number().int().nonnegative(),
    dueCount: z.number().int().nonnegative(),
    introducedToday: z.number().int().nonnegative(),
    newPassageAvailable: z.boolean(),
    nextQueued: recitationIntroductionNextQueuedSchema.nullable(),
    phase: recitationPhaseDtoSchema,
    planEntryId: z.string(),
    reason: z.enum(recitationIntroductionReasons),
    remainingCapacity: z.number().int().nonnegative()
  })
  .strict();

export type RecitationIntroductionStatusDto = z.infer<typeof recitationIntroductionStatusDtoSchema>;

// The result of introducing the next queued passage (#607): the newly-activated passage (now an active
// card at the 0.95 recitation retention) plus the fresh introduction status, so the client updates the
// action and the pacing state in one round-trip.
export const activateNextRecitationPassageResponseSchema = z
  .object({
    passage: recitationPassageDtoSchema,
    status: recitationIntroductionStatusDtoSchema
  })
  .strict();

export type ActivateNextRecitationPassageResponse = z.infer<
  typeof activateNextRecitationPassageResponseSchema
>;

// Split a passage at a text position: the block and character offset to cut at (strictly inside the
// passage). The passage to split is named in the route path.
export const splitRecitationPassageRequestSchema = z
  .object({ atBlockEntryId: nonBlankString, atOffset: z.number().int().nonnegative() })
  .strict();

export type SplitRecitationPassageRequest = z.infer<typeof splitRecitationPassageRequestSchema>;

// The due passage to practise, or null when nothing is due (Today shows no overdue wall). `context` is
// the Work/section framing; `precedingText` is the previous passage's text (null for the first passage)
// so the client can render the `preceding_line` cue; `targetText` is the exact source, kept hidden by
// the client until Reveal. The client derives cue text from these via the domain, so switching cue
// strength before attempting needs no round-trip.
export const dueRecitationPassageDtoSchema = z
  .object({
    anchorStatus: recitationAnchorStatusDtoSchema,
    context: z.string(),
    defaultCueStrength: recitationCueStrengthDtoSchema,
    passageEntryId: z.string(),
    planEntryId: z.string(),
    precedingText: z.string().nullable(),
    supportLevel: recitationSupportLevelDtoSchema,
    targetText: z.string(),
    workTitle: z.string()
  })
  .strict();

export type DueRecitationPassageDto = z.infer<typeof dueRecitationPassageDtoSchema>;

export const dueRecitationPassageResponseSchema = z
  .object({ passage: dueRecitationPassageDtoSchema.nullable() })
  .strict();

export type DueRecitationPassageResponse = z.infer<typeof dueRecitationPassageResponseSchema>;

// Set the remembered visual support level for a passage (#579). This is a preference, not a recall: it
// never touches the FSRS schedule and never counts as a review. The passage is named in the route path.
export const setRecitationSupportLevelRequestSchema = z
  .object({ supportLevel: recitationSupportLevelDtoSchema })
  .strict();

export type SetRecitationSupportLevelRequest = z.infer<
  typeof setRecitationSupportLevelRequestSchema
>;

export const setRecitationSupportLevelResponseSchema = z
  .object({ supportLevel: recitationSupportLevelDtoSchema })
  .strict();

export type SetRecitationSupportLevelResponse = z.infer<
  typeof setRecitationSupportLevelResponseSchema
>;

// Record a self-assessment: the rating that updates the FSRS schedule and the cue strength the learner
// attempted from (metadata only). Revealing without rating never sends this, so the schedule is
// unchanged. `leadInFailed` marks that the optional ungraded predecessor lead-in (#580) broke down, so
// the immediately preceding passage also receives an Again; it defaults false, leaving the lead-in
// ungraded and only the due target rated. The passage is named in the route path; user and time are
// server-resolved.
export const recordRecitationReviewRequestSchema = z
  .object({
    cueStrength: recitationCueStrengthDtoSchema,
    leadInFailed: z.boolean().default(false),
    rating: recitationReviewRatingSchema
  })
  .strict();

export type RecordRecitationReviewRequest = z.infer<typeof recordRecitationReviewRequestSchema>;

export const recordRecitationReviewResponseSchema = z
  .object({ passage: recitationPassageDtoSchema })
  .strict();

export type RecordRecitationReviewResponse = z.infer<typeof recordRecitationReviewResponseSchema>;

export function parseRecitationPassageListDto(value: unknown): RecitationPassageListDto {
  return recitationPassageListDtoSchema.parse(value);
}

export function parseRecitationIntroductionStatusDto(
  value: unknown
): RecitationIntroductionStatusDto {
  return recitationIntroductionStatusDtoSchema.parse(value);
}

export function parseActivateNextRecitationPassageResponse(
  value: unknown
): ActivateNextRecitationPassageResponse {
  return activateNextRecitationPassageResponseSchema.parse(value);
}

export function parseSplitRecitationPassageRequest(value: unknown): SplitRecitationPassageRequest {
  return splitRecitationPassageRequestSchema.parse(value);
}

export function parseDueRecitationPassageResponse(value: unknown): DueRecitationPassageResponse {
  return dueRecitationPassageResponseSchema.parse(value);
}

export function parseRecordRecitationReviewRequest(value: unknown): RecordRecitationReviewRequest {
  return recordRecitationReviewRequestSchema.parse(value);
}

export function parseRecordRecitationReviewResponse(
  value: unknown
): RecordRecitationReviewResponse {
  return recordRecitationReviewResponseSchema.parse(value);
}

export function parseSetRecitationSupportLevelRequest(
  value: unknown
): SetRecitationSupportLevelRequest {
  return setRecitationSupportLevelRequestSchema.parse(value);
}

export function parseSetRecitationSupportLevelResponse(
  value: unknown
): SetRecitationSupportLevelResponse {
  return setRecitationSupportLevelResponseSchema.parse(value);
}
