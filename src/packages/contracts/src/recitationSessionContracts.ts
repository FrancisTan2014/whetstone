import { recitationSessionSteps } from "@whetstone/domain";
import { z } from "zod";

// Shared, Zod-validated shapes for the transient recitation session (#609). The session owns no queue:
// the server's `step` is its due-first pick at fetch time, and the raw booleans are included so the
// client can recompute locally after a transient chain dismissal without persisting scheduler state.

export const recitationSessionStepDtoSchema = z.enum(recitationSessionSteps);

export type RecitationSessionStepDto = z.infer<typeof recitationSessionStepDtoSchema>;

const sessionDueSchema = z
  .object({
    dueCount: z.number().int().nonnegative(),
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
      paused: z.boolean(),
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
