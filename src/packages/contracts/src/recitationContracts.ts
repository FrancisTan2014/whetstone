import { recitationPhases } from "@whetstone/domain";
import { z } from "zod";

// Shared, Zod-validated shapes for recitation routines (#577): a learner adopts a source Work as a
// recitation plan, chooses an initial phase, and moves through familiarization into active recitation on
// their own schedule. Every value crossing the recitation API is described here; the server validates once
// at the boundary and trusts the typed data inward.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The learner-controlled routine phase, reusing the domain vocabulary so DTO and domain never drift.
export const recitationPhaseDtoSchema = z.enum(recitationPhases);

export type RecitationPhaseDto = z.infer<typeof recitationPhaseDtoSchema>;

// Adopting a Work as a recitation routine: the source Work to link to and the initial phase the learner
// picks (so an already-recited work can start in maintenance and a new one in familiarizing). The source
// content stays canonical — only a link is created, nothing is copied.
export const createRecitationPlanRequestSchema = z
  .object({
    phase: recitationPhaseDtoSchema,
    workEntryId: z.string().refine(isNonBlank, { message: "workEntryId must be non-empty." })
  })
  .strict();

export type CreateRecitationPlanRequest = z.infer<typeof createRecitationPlanRequestSchema>;

// The explicit, learner-driven phase transition (e.g. "Start reciting"): only ever changed by an explicit
// action — whetstone never infers readiness, requires a test, or auto-advances after N days.
export const setRecitationPhaseRequestSchema = z
  .object({ phase: recitationPhaseDtoSchema })
  .strict();

export type SetRecitationPhaseRequest = z.infer<typeof setRecitationPhaseRequestSchema>;

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

// Today's "Continue recitation" target: the learner's most recently touched recitation plan, or null when
// they have adopted none.
export const continueRecitationDtoSchema = z
  .object({ plan: recitationPlanDtoSchema.nullable() })
  .strict();

export type ContinueRecitationDto = z.infer<typeof continueRecitationDtoSchema>;

export function parseCreateRecitationPlanRequest(value: unknown): CreateRecitationPlanRequest {
  return createRecitationPlanRequestSchema.parse(value);
}

export function parseSetRecitationPhaseRequest(value: unknown): SetRecitationPhaseRequest {
  return setRecitationPhaseRequestSchema.parse(value);
}

export function parseRecitationPlanDto(value: unknown): RecitationPlanDto {
  return recitationPlanDtoSchema.parse(value);
}

export function parseRecitationPlanListDto(value: unknown): RecitationPlanListDto {
  return recitationPlanListDtoSchema.parse(value);
}

export function parseContinueRecitationDto(value: unknown): ContinueRecitationDto {
  return continueRecitationDtoSchema.parse(value);
}
