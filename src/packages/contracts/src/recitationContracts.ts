import { recitationPhases } from "@whetstone/domain";
import { z } from "zod";

// Shared, Zod-validated shapes for direct Work-level Recitation maintenance (#643): the learner declares
// a known Work retrievable ("I can recite this"), it is enrolled straight into FSRS maintenance, and its
// single Work-level review card owns retrieval and scheduling. The source Work stays canonical — only a
// link is created, nothing is copied. The server validates once at the boundary and trusts the typed data
// inward.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The learner-controlled routine phase vocabulary, reused from the domain. Direct enrolment always lands
// a plan in `maintenance`; the earlier phases survive only so legacy plan rows stay readable in the DTO.
export const recitationPhaseDtoSchema = z.enum(recitationPhases);

export type RecitationPhaseDto = z.infer<typeof recitationPhaseDtoSchema>;

// Enrolling a known Work into Recitation maintenance: only the source Work to link to — the phase is no
// longer a learner choice (#643 removes the phase picker), and no rating is inferred from the action.
export const enrollRecitationRequestSchema = z
  .object({
    workEntryId: z.string().refine(isNonBlank, { message: "workEntryId must be non-empty." })
  })
  .strict();

export type EnrollRecitationRequest = z.infer<typeof enrollRecitationRequestSchema>;

// A persisted recitation plan: its own entry id, the source Work it links to (with the Work's title for
// display), the current phase, and the lightweight routine state. `lastSessionAt` is null until the first
// reading session; `sessionCount` counts sessions. Timestamps come from the shared personal-entry facet.
export const recitationPlanDtoSchema = z
  .object({
    createdAt: z.string(),
    entryId: z.string(),
    lastSessionAt: z.string().nullable(),
    phase: recitationPhaseDtoSchema,
    sessionCount: z.number().int().nonnegative(),
    updatedAt: z.string(),
    workEntryId: z.string(),
    workTitle: z.string()
  })
  .strict();

export type RecitationPlanDto = z.infer<typeof recitationPlanDtoSchema>;

export const recitationPlanListDtoSchema = z
  .object({ plans: z.array(recitationPlanDtoSchema) })
  .strict();

export type RecitationPlanListDto = z.infer<typeof recitationPlanListDtoSchema>;

// The four FSRS ratings the learner picks after revealing the canonical source, worst→best. The review
// UI reads the human labels from `recitationRatingChoices` in the domain; the wire value is the rating.
export const recitationReviewRatingSchema = z.enum(["again", "hard", "good", "easy"]);

export type RecitationReviewRating = z.infer<typeof recitationReviewRatingSchema>;

// The FSRS lifecycle state of a Work-level maintenance card, surfaced so the review can show where the
// Work sits in its schedule without re-deriving it client-side.
export const recitationReviewCardStateSchema = z.enum(["new", "learning", "review", "relearning"]);

export type RecitationReviewCardStateDto = z.infer<typeof recitationReviewCardStateSchema>;

// The Work-level maintenance review to present (#643): the plan/Work identity, the Work title, the
// canonical `sourceText` revealed after an attempt (read live from the Work's blocks — never copied into
// recitation state), and the card's current due instant and FSRS state. One review per enrolled Work.
export const recitationReviewDtoSchema = z
  .object({
    dueAt: z.string().datetime(),
    planEntryId: z.string(),
    sourceText: z.string(),
    state: recitationReviewCardStateSchema,
    workEntryId: z.string(),
    workTitle: z.string()
  })
  .strict();

export type RecitationReviewDto = z.infer<typeof recitationReviewDtoSchema>;

// A fetch of a Work's current review: the review when the Work is enrolled with an active card, else null
// so the client routes back to a Library recovery path instead of opening a dead screen.
export const recitationReviewResponseSchema = z
  .object({ review: recitationReviewDtoSchema.nullable() })
  .strict();

export type RecitationReviewResponse = z.infer<typeof recitationReviewResponseSchema>;

// Recording one Work-level review: the learner's rating. Reveal is a client concern and writes no event;
// exactly one rating appends one review event and reschedules only this Work's card.
export const recordRecitationReviewRequestSchema = z
  .object({ rating: recitationReviewRatingSchema })
  .strict();

export type RecordRecitationReviewRequest = z.infer<typeof recordRecitationReviewRequestSchema>;

// The rescheduled review after a rating (#637): the same review shape with the card's next due instant +
// state, plus `remainingDueCount` — how many OTHER Works still hold a due card, recomputed from the
// canonical due cards right after this reschedule (the just-rated card is now scheduled forward, so it is
// never counted). The review UI keys its continuation off it: > 0 offers an optional "Review next" (the
// next Work never opens automatically), 0 shows "Due complete". No session queue or cursor is persisted.
export const recordRecitationReviewResponseSchema = z
  .object({
    remainingDueCount: z.number().int().nonnegative(),
    review: recitationReviewDtoSchema
  })
  .strict();

export type RecordRecitationReviewResponse = z.infer<typeof recordRecitationReviewResponseSchema>;

// One enrolled Work as the Recite home presents it (#638): the plan/Work identity and title, plus the
// Work-level maintenance card's schedule read live — `nextReviewAt` is the card's next due instant (null
// when maintenance was removed and no active card remains), `state` its FSRS lifecycle, `isDue` whether it
// is due now (always false while paused), and `paused` whether the learner has withheld it from the due
// scan. Derived, never stored: the Recite landing shows due state and next review dates without the client
// re-deriving them.
export const recitationOverviewWorkSchema = z
  .object({
    isDue: z.boolean(),
    nextReviewAt: z.string().datetime().nullable(),
    paused: z.boolean(),
    planEntryId: z.string(),
    state: recitationReviewCardStateSchema.nullable(),
    workEntryId: z.string(),
    workTitle: z.string()
  })
  .strict();

export type RecitationOverviewWorkDto = z.infer<typeof recitationOverviewWorkSchema>;

// The Recite home payload (#638): every enrolled Work with its live due state and next review date, newest
// enrolled first, plus `dueCount` — how many Works hold a due card right now — so the landing can lead with
// due maintenance without recomputing it client-side.
export const recitationOverviewDtoSchema = z
  .object({
    dueCount: z.number().int().nonnegative(),
    works: z.array(recitationOverviewWorkSchema)
  })
  .strict();

export type RecitationOverviewDto = z.infer<typeof recitationOverviewDtoSchema>;

export function parseEnrollRecitationRequest(value: unknown): EnrollRecitationRequest {
  return enrollRecitationRequestSchema.parse(value);
}

export function parseRecitationPlanDto(value: unknown): RecitationPlanDto {
  return recitationPlanDtoSchema.parse(value);
}

export function parseRecitationPlanListDto(value: unknown): RecitationPlanListDto {
  return recitationPlanListDtoSchema.parse(value);
}

export function parseRecitationReviewResponse(value: unknown): RecitationReviewResponse {
  return recitationReviewResponseSchema.parse(value);
}

export function parseRecordRecitationReviewRequest(value: unknown): RecordRecitationReviewRequest {
  return recordRecitationReviewRequestSchema.parse(value);
}

export function parseRecordRecitationReviewResponse(
  value: unknown
): RecordRecitationReviewResponse {
  return recordRecitationReviewResponseSchema.parse(value);
}

export function parseRecitationOverviewDto(value: unknown): RecitationOverviewDto {
  return recitationOverviewDtoSchema.parse(value);
}
