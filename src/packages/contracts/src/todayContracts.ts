import { z } from "zod";

import { authoredWorkSummaryDtoSchema } from "./authoredWorkContracts.js";
import { latestReadingPositionDtoSchema } from "./readingPositionContracts.js";

// The server-composed Today board (#610): a data-only read model over feature-owned obligations and
// invitations for the learner's local day (#606). It carries NO copy, labels, or links — the client
// derives all learner-facing text and deep links per kind — and persists no Today state of its own.

// The deterministic-obligation sources Today groups into one row each. Only Recitation (#609) and Memory
// review are dated commitments; no other source exists, so the kinds are a closed set.
export const todayRoutineKinds = ["recitation", "memory"] as const;

export const todayRoutineKindSchema = z.enum(todayRoutineKinds);

export type TodayRoutineKind = z.infer<typeof todayRoutineKindSchema>;

// One grouped Due-now routine: a positive count of due obligations (never one row per prompt/passage),
// how many are overdue, and the earliest due instant Today orders by. `dueCount` is strictly positive
// because a routine with nothing due is simply absent from Due now.
export const todayRoutineDtoSchema = z
  .object({
    dueCount: z.number().int().positive(),
    kind: todayRoutineKindSchema,
    nextDueAt: z.string().datetime(),
    overdue: z.boolean(),
    overdueCount: z.number().int().nonnegative()
  })
  .strict();

export type TodayRoutineDto = z.infer<typeof todayRoutineDtoSchema>;

// Continue reading: the learner's latest cross-work position when one exists, an explicit empty when the
// learner has read nothing, or a failed load the client surfaces as a quiet retry (never a false clear).
const todayContinueReadingSchema = z.discriminatedUnion("status", [
  z.object({ position: latestReadingPositionDtoSchema, status: z.literal("ready") }).strict(),
  z.object({ status: z.literal("empty") }).strict(),
  z.object({ status: z.literal("failed") }).strict()
]);

// Continue writing: the most recently edited authored Work, an explicit empty when nothing is authored,
// or a failed load surfaced quietly.
const todayContinueWritingSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), work: authoredWorkSummaryDtoSchema }).strict(),
  z.object({ status: z.literal("empty") }).strict(),
  z.object({ status: z.literal("failed") }).strict()
]);

// The Recitation "New passage" invitation (#607): available (with the plan to route into), unavailable,
// or a failed load. It is an invitation, never an obligation — it never blocks the clear state.
const todayNewPassageSchema = z.discriminatedUnion("status", [
  z.object({ planEntryId: z.string(), status: z.literal("available") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({ status: z.literal("failed") }).strict()
]);

export const todayBoardDtoSchema = z
  .object({
    // The learner's local `YYYY-MM-DD` day key (#606) the board was composed for.
    date: z.string(),
    // Overdue-first, then earliest `nextDueAt`, then kind — the deterministic obligation order.
    dueNow: z.array(todayRoutineDtoSchema),
    // True only when every due routine is clear AND no routine source failed to load.
    clear: z.boolean(),
    continueReading: todayContinueReadingSchema,
    continueWriting: todayContinueWritingSchema,
    newPassage: todayNewPassageSchema,
    // Routine sources whose load threw. A non-empty list forces `clear` false so one failing source
    // never presents a false global clear.
    routineFailures: z.array(todayRoutineKindSchema)
  })
  .strict();

export type TodayBoardDto = z.infer<typeof todayBoardDtoSchema>;

export const todayBoardResponseSchema = z.object({ board: todayBoardDtoSchema }).strict();

export type TodayBoardResponse = z.infer<typeof todayBoardResponseSchema>;

export function parseTodayBoardResponse(value: unknown): TodayBoardResponse {
  return todayBoardResponseSchema.parse(value);
}
