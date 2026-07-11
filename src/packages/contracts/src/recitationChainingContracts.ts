import { recitationReviewRatingSchema } from "./recitationPassageContracts.js";
import { z } from "zod";

// Shared, Zod-validated shapes for maintaining recitation through contiguous chaining (#580): the
// progress view over a plan (owned prefix, chain eligibility, whole-work eligibility, the active chain
// and whole-work state), starting and completing a contiguous chain session, and reviewing the
// whole-work maintenance prompt. Every value crossing the chaining API is described here; the server
// validates once at the boundary and trusts the typed data inward. None of these are Timeline Entries.

// The contiguous owned span from the Work's beginning: how many passages are currently owned without a
// gap, and the total passage count. A disconnected later island of mastery never inflates `ownedCount`.
export const ownedPrefixDtoSchema = z
  .object({
    ownedCount: z.number().int().nonnegative(),
    total: z.number().int().nonnegative()
  })
  .strict();

export type OwnedPrefixDto = z.infer<typeof ownedPrefixDtoSchema>;

// Whether a chain session may be offered and, if so, the furthest end boundary (0-based passage index)
// the learner may choose — the last passage of the owned prefix.
export const chainEligibilityDtoSchema = z.discriminatedUnion("status", [
  z.object({ maxEndIndex: z.number().int().nonnegative(), status: z.literal("eligible") }).strict(),
  z.object({ status: z.literal("not_eligible") }).strict()
]);

export type ChainEligibilityDto = z.infer<typeof chainEligibilityDtoSchema>;

// One passage inside a chain, in fixed source order: its id, reciting position, and exact source text
// (so the client can render the contiguous sequence and let the learner identify where recall broke).
export const chainPassageDtoSchema = z
  .object({
    orderIndex: z.number().int().nonnegative(),
    passageEntryId: z.string(),
    sourceText: z.string()
  })
  .strict();

export type ChainPassageDto = z.infer<typeof chainPassageDtoSchema>;

// An active or completed contiguous chain session: the run of passages [0..endOrderIndex] in fixed
// order, none skipped. `chainId` identifies the persisted session; it is not an Entry.
export const recitationChainDtoSchema = z
  .object({
    chainId: z.string(),
    endOrderIndex: z.number().int().nonnegative(),
    passages: z.array(chainPassageDtoSchema),
    planEntryId: z.string(),
    status: z.enum(["active", "completed"])
  })
  .strict();

export type RecitationChainDto = z.infer<typeof recitationChainDtoSchema>;

// The whole-work maintenance prompt's own FSRS state (separate from every passage): whether it exists
// yet, when it is next due, and whether it is due now. Null `dueAt` until the learner starts it.
export const wholeWorkStateDtoSchema = z
  .object({
    due: z.boolean(),
    dueAt: z.string().nullable(),
    exists: z.boolean()
  })
  .strict();

export type WholeWorkStateDto = z.infer<typeof wholeWorkStateDtoSchema>;

// The full chaining progress for one plan, as computed at request time (never stored as an Entry).
export const recitationChainingDtoSchema = z
  .object({
    activeChain: recitationChainDtoSchema.nullable(),
    chainEligibility: chainEligibilityDtoSchema,
    ownedPrefix: ownedPrefixDtoSchema,
    planEntryId: z.string(),
    wholeWork: wholeWorkStateDtoSchema,
    wholeWorkOwned: z.boolean()
  })
  .strict();

export type RecitationChainingDto = z.infer<typeof recitationChainingDtoSchema>;

export const recitationChainingResponseSchema = z
  .object({ chaining: recitationChainingDtoSchema })
  .strict();

export type RecitationChainingResponse = z.infer<typeof recitationChainingResponseSchema>;

// Start a contiguous chain session ending at the chosen 0-based passage index. The start is always the
// Work's first passage; the boundary must fall within the owned prefix and yield at least two passages.
export const startRecitationChainRequestSchema = z
  .object({ endOrderIndex: z.number().int().nonnegative() })
  .strict();

export type StartRecitationChainRequest = z.infer<typeof startRecitationChainRequestSchema>;

export const recitationChainResponseSchema = z.object({ chain: recitationChainDtoSchema }).strict();

export type RecitationChainResponse = z.infer<typeof recitationChainResponseSchema>;

// The outcome of a chain or whole-work reveal: recall held throughout, or it broke at one explicitly
// identified passage. Nothing is inferred — only an identified passage is failed with an Again.
export const sessionRecallOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("held") }).strict(),
  z.object({ passageEntryId: z.string(), status: z.literal("broke") }).strict()
]);

export type SessionRecallOutcomeDto = z.infer<typeof sessionRecallOutcomeSchema>;

// Complete an active chain session, reporting whether recall held or broke at an identified passage.
export const completeRecitationChainRequestSchema = z
  .object({ outcome: sessionRecallOutcomeSchema })
  .strict();

export type CompleteRecitationChainRequest = z.infer<typeof completeRecitationChainRequestSchema>;

// Review the whole-work maintenance prompt: the aggregate FSRS rating (a lapse reschedules only this
// aggregate prompt), plus the reveal outcome so an explicitly identified broken passage also gets an
// Again — no passage is reset merely because the whole-work prompt lapsed.
export const reviewWholeWorkRequestSchema = z
  .object({
    outcome: sessionRecallOutcomeSchema,
    rating: recitationReviewRatingSchema
  })
  .strict();

export type ReviewWholeWorkRequest = z.infer<typeof reviewWholeWorkRequestSchema>;

export const wholeWorkResponseSchema = z.object({ wholeWork: wholeWorkStateDtoSchema }).strict();

export type WholeWorkResponse = z.infer<typeof wholeWorkResponseSchema>;

// The single recitation action Today surfaces, chosen across the learner's plans in fixed priority
// (due passage > active chain > whole-work > none). At most one, so Today is never an overdue wall.
export const recitationTodayActionDtoSchema = z.enum([
  "due_passage",
  "chain",
  "whole_work",
  "none"
]);

export type RecitationTodayActionDto = z.infer<typeof recitationTodayActionDtoSchema>;

export const recitationTodayDtoSchema = z
  .object({
    action: recitationTodayActionDtoSchema,
    activeChain: recitationChainDtoSchema.nullable(),
    planEntryId: z.string().nullable(),
    workTitle: z.string().nullable()
  })
  .strict();

export type RecitationTodayDto = z.infer<typeof recitationTodayDtoSchema>;

export const recitationTodayResponseSchema = z.object({ today: recitationTodayDtoSchema }).strict();

export type RecitationTodayResponse = z.infer<typeof recitationTodayResponseSchema>;

export function parseRecitationChainingResponse(value: unknown): RecitationChainingResponse {
  return recitationChainingResponseSchema.parse(value);
}

export function parseStartRecitationChainRequest(value: unknown): StartRecitationChainRequest {
  return startRecitationChainRequestSchema.parse(value);
}

export function parseRecitationChainResponse(value: unknown): RecitationChainResponse {
  return recitationChainResponseSchema.parse(value);
}

export function parseCompleteRecitationChainRequest(
  value: unknown
): CompleteRecitationChainRequest {
  return completeRecitationChainRequestSchema.parse(value);
}

export function parseReviewWholeWorkRequest(value: unknown): ReviewWholeWorkRequest {
  return reviewWholeWorkRequestSchema.parse(value);
}

export function parseWholeWorkResponse(value: unknown): WholeWorkResponse {
  return wholeWorkResponseSchema.parse(value);
}

export function parseRecitationTodayResponse(value: unknown): RecitationTodayResponse {
  return recitationTodayResponseSchema.parse(value);
}
