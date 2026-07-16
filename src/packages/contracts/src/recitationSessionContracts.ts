import { recitationSessionSteps } from "@whetstone/domain";
import { z } from "zod";

// Shared, Zod-validated shapes for the transient recitation session (#609/#633). The session owns no
// queue: the server's `step` is its due-first pick at fetch time over the aggregate across every unpaused
// plan, and the raw booleans are the selected Work's, so the client can recompute locally after a
// transient chain dismissal without persisting scheduler state.

export const recitationSessionStepDtoSchema = z.enum(recitationSessionSteps);

export type RecitationSessionStepDto = z.infer<typeof recitationSessionStepDtoSchema>;

const sessionDueSchema = z
  .object({
    dueCount: z.number().int().nonnegative(),
    // The earliest due active card's instant across every unpaused plan, or null when nothing is due.
    // Today (#610) reads this to order the grouped Recitation routine among the day's obligations.
    nextDueAt: z.string().datetime().nullable(),
    overdueCount: z.number().int().nonnegative()
  })
  .strict();

const sessionNewPassageSchema = z
  .object({
    anyIntroduced: z.boolean(),
    available: z.boolean(),
    dailyCap: z.number().int().nonnegative(),
    introducedToday: z.number().int().nonnegative(),
    remainingCapacity: z.number().int().nonnegative()
  })
  .strict();

export const recitationSessionDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_plan") }).strict(),
  z
    .object({
      chainAvailable: z.boolean(),
      due: sessionDueSchema,
      hasDuePassage: z.boolean(),
      newPassage: sessionNewPassageSchema,
      planEntryId: z.string(),
      status: z.literal("active"),
      step: recitationSessionStepDtoSchema,
      wholeWorkDue: z.boolean(),
      workTitle: z.string()
    })
    .strict()
]);

export type RecitationSessionDto = z.infer<typeof recitationSessionDtoSchema>;

export const recitationSessionResponseSchema = z
  .object({ session: recitationSessionDtoSchema })
  .strict();

export type RecitationSessionResponse = z.infer<typeof recitationSessionResponseSchema>;

export function parseRecitationSessionResponse(value: unknown): RecitationSessionResponse {
  return recitationSessionResponseSchema.parse(value);
}
