import { isDayKey } from "@whetstone/domain";
import { z } from "zod";

// Shared, Zod-validated shapes for the tap-and-talk voice diary (#246): the create/edit requests, the
// persisted diary entry, the day-grouped Timeline page (a generic dated-trace shape so notes/practice
// deposits can join later as a `kind` filter), and the date-jump calendar's marked dates. Every value
// crossing the diary API is described here; the server validates once at the boundary.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

const dayKeySchema = z.string().refine(isDayKey, { message: "must be a YYYY-MM-DD date." });

// Capture: the web posts the STT transcript; the server runs the tidy pass and stamps today + now.
export const createDiaryEntryRequestSchema = z
  .object({
    transcript: z.string().refine(isNonBlank, { message: "transcript must be non-empty." })
  })
  .strict();

export type CreateDiaryEntryRequest = z.infer<typeof createDiaryEntryRequestSchema>;

// Editing changes only the tidied text; the entry's date and timestamp are fixed at capture.
export const updateDiaryEntryRequestSchema = z
  .object({
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." })
  })
  .strict();

export type UpdateDiaryEntryRequest = z.infer<typeof updateDiaryEntryRequestSchema>;

// A persisted diary entry. `language` is the free-form detected/provided language (null when unknown in
// v0); `entryDate` is the `YYYY-MM-DD` day it is filed under; `createdAt` is the ISO capture instant.
export const diaryEntryDtoSchema = z
  .object({
    createdAt: z.string(),
    entryDate: dayKeySchema,
    id: z.string(),
    language: z.string().nullable(),
    text: z.string()
  })
  .strict();

export type DiaryEntryDto = z.infer<typeof diaryEntryDtoSchema>;

// One entry in the Timeline. `kind` is a discriminator so other dated traces can join the timeline later
// as filters; in v0 the only kind is "diary", backed by `diary_entries`.
export const timelineEntryDtoSchema = z
  .object({
    createdAt: z.string(),
    id: z.string(),
    kind: z.literal("diary"),
    language: z.string().nullable(),
    text: z.string()
  })
  .strict();

export type TimelineEntryDto = z.infer<typeof timelineEntryDtoSchema>;

// A day's worth of timeline entries (entries within a day ordered oldest-first by `createdAt`).
export const timelineDayDtoSchema = z
  .object({
    date: dayKeySchema,
    entries: z.array(timelineEntryDtoSchema)
  })
  .strict();

export type TimelineDayDto = z.infer<typeof timelineDayDtoSchema>;

// One lazy-loaded page of the Timeline: a bounded run of days, newest-first. Empty `days` means no more.
export const timelineDtoSchema = z.object({ days: z.array(timelineDayDtoSchema) }).strict();

export type TimelineDto = z.infer<typeof timelineDtoSchema>;

// The dates in a range that have ≥1 entry — the marks the date-jump calendar paints.
export const diaryCalendarDtoSchema = z.object({ dates: z.array(dayKeySchema) }).strict();

export type DiaryCalendarDto = z.infer<typeof diaryCalendarDtoSchema>;

// The lazy-load cursor: page the days strictly before `before` (omitted on the first page), bounded to
// `limit` days. Query params arrive as strings, so `limit` is coerced.
export const timelineQuerySchema = z
  .object({
    before: dayKeySchema.optional(),
    limit: z.coerce.number().int().positive().max(100).optional()
  })
  .strict();

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

// The calendar marks query: the inclusive day-key range to scan for entry-bearing days.
export const diaryCalendarQuerySchema = z
  .object({
    from: dayKeySchema,
    to: dayKeySchema
  })
  .strict();

export type DiaryCalendarQuery = z.infer<typeof diaryCalendarQuerySchema>;

export function parseDiaryEntryDto(value: unknown): DiaryEntryDto {
  return diaryEntryDtoSchema.parse(value);
}

export function parseTimelineDto(value: unknown): TimelineDto {
  return timelineDtoSchema.parse(value);
}

export function parseDiaryCalendarDto(value: unknown): DiaryCalendarDto {
  return diaryCalendarDtoSchema.parse(value);
}

export function parseCreateDiaryEntryRequest(value: unknown): CreateDiaryEntryRequest {
  return createDiaryEntryRequestSchema.parse(value);
}

export function parseUpdateDiaryEntryRequest(value: unknown): UpdateDiaryEntryRequest {
  return updateDiaryEntryRequestSchema.parse(value);
}
