import { recitationRoutineStages } from "@whetstone/domain";
import { z } from "zod";

import { recitationTodayActionDtoSchema } from "./recitationChainingContracts.js";
import { recitationPhaseDtoSchema } from "./recitationContracts.js";
import { recitationIntroductionStatusDtoSchema } from "./recitationPassageContracts.js";

// Shared, Zod-validated shapes for the recitation routine hub (#608): one calm projection answering what
// needs attention now, where the learner is in this Work, and the next available action. The hub owns NO
// parallel progress — every field is derived at request time from canonical plan/passage/chain/whole-Work
// rows joined to the shared card state, so DTO and domain never drift. The server validates once at the
// boundary and trusts the typed data inward.

// The derived "where am I" routine stage, reusing the domain vocabulary so DTO and derivation never drift.
export const recitationRoutineStageDtoSchema = z.enum(recitationRoutineStages);

export type RecitationRoutineStageDto = z.infer<typeof recitationRoutineStageDtoSchema>;

// Owned/introduced passage progress rendered as human copy in the web layer ("N of M passages
// introduced"), never a chart. Both counts are derived from canonical passage rows.
const hubPassagesProgressSchema = z
  .object({
    introducedCount: z.number().int().nonnegative(),
    totalCount: z.number().int().nonnegative()
  })
  .strict();

// Due/overdue obligations over the plan's ACTIVE shared cards (passage cards + the whole-Work card).
// `dueCount` is cards due at or before now; `overdueCount` is the subset carried over from a previous
// local day (due before the learner's local-day boundary), so `overdueCount <= dueCount` always.
const hubDueSchema = z
  .object({
    dueCount: z.number().int().nonnegative(),
    overdueCount: z.number().int().nonnegative()
  })
  .strict();

// The hub view: the learner has adopted no plan yet (`no_plan` → a restrained empty state), navigated to
// a specific Work they have not adopted (`unadopted_work` → that Work's adoption state, carrying its
// title so the hub never falls back to the most-recent plan — #633 AC7), or an active plan projection.
// When active, `paused` reflects the plan-level pause; a paused plan surfaces no due obligation or
// primary action (its cards are removed from selection) but keeps all progress.
export const recitationHubDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_plan") }).strict(),
  z
    .object({
      status: z.literal("unadopted_work"),
      workEntryId: z.string(),
      workTitle: z.string()
    })
    .strict(),
  z
    .object({
      due: hubDueSchema,
      introduction: recitationIntroductionStatusDtoSchema,
      passages: hubPassagesProgressSchema,
      paused: z.boolean(),
      phase: recitationPhaseDtoSchema,
      planEntryId: z.string(),
      primaryAction: recitationTodayActionDtoSchema,
      stage: recitationRoutineStageDtoSchema,
      status: z.literal("active"),
      workTitle: z.string()
    })
    .strict()
]);

export type RecitationHubDto = z.infer<typeof recitationHubDtoSchema>;

export const recitationHubResponseSchema = z.object({ hub: recitationHubDtoSchema }).strict();

export type RecitationHubResponse = z.infer<typeof recitationHubResponseSchema>;

export function parseRecitationHubResponse(value: unknown): RecitationHubResponse {
  return recitationHubResponseSchema.parse(value);
}
