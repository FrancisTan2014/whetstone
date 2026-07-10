import { type DocumentNodeJSON, isValidDocument } from "@whetstone/document";
import { isDayKey, timelineEntryKinds } from "@whetstone/domain";
import { z } from "zod";

import { captureInputModeSchema, captureLanguageSchema } from "./captureContracts.js";

// Shared, Zod-validated shapes for the rich Diary Entry and the logical Timeline (#571). A diary artifact
// is a personal Entry whose durable body is a ProseMirror/Tiptap document edited through the shared rich
// editor; the Timeline is a chronological view over the current user's personal Entries (diary + note),
// never a stored object. Every value crossing the diary/timeline API is described here; the server
// validates once at the boundary.

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

const dayKeySchema = z.string().refine(isDayKey, { message: "must be a YYYY-MM-DD date." });

// A ProseMirror/Tiptap document, validated against the shared document schema so a malformed or unsafe
// body never reaches storage or a client. Typed as `DocumentNodeJSON` for consumers.
export const documentJsonSchema = z.custom<DocumentNodeJSON>(isValidDocument, {
  message: "must be a valid document."
});

const processingStatuses = ["queued", "transcribing", "tidying", "ready", "failed"] as const;

export const diaryProcessingStatusSchema = z.enum(processingStatuses);

export type DiaryProcessingStatus = z.infer<typeof diaryProcessingStatusSchema>;

// Capture: the web posts the transcript (typed text or STT transcript) plus how it was entered
// (`inputMode`) and the manual capture language. The server saves the Diary Entry FIRST (before any async
// tidy/transcription), stamps occurredAt/createdAt/updatedAt, and builds the initial body from the text.
export const createDiaryEntryRequestSchema = z
  .object({
    inputMode: captureInputModeSchema,
    language: captureLanguageSchema,
    transcript: z.string().refine(isNonBlank, { message: "transcript must be non-empty." })
  })
  .strict();

export type CreateDiaryEntryRequest = z.infer<typeof createDiaryEntryRequestSchema>;

// Editing a diary body replaces the rich document (`bodyDoc`) through the shared editor, and may update
// the language. The entry's occurredAt/createdAt are fixed at capture; the server bumps updatedAt.
export const updateDiaryEntryRequestSchema = z
  .object({
    bodyDoc: documentJsonSchema,
    language: captureLanguageSchema.nullish()
  })
  .strict();

export type UpdateDiaryEntryRequest = z.infer<typeof updateDiaryEntryRequestSchema>;

// A persisted Diary Entry. `bodyDoc` is the durable ProseMirror/Tiptap document; `bodyText` is its
// plaintext projection (preview/search). `occurredAt`/`createdAt`/`updatedAt` are ISO instants from the
// shared personal-entry chronology facet. `processingStatus` is null for a synchronous typed capture that
// is ready on write; only the queued voice path carries a status. `failureReason` is set only on failure.
export const diaryEntryDtoSchema = z
  .object({
    bodyDoc: documentJsonSchema,
    bodyText: z.string(),
    createdAt: z.string(),
    failureReason: z.string().nullable(),
    id: z.string(),
    inputMode: captureInputModeSchema,
    language: z.string().nullable(),
    occurredAt: z.string(),
    processingStatus: diaryProcessingStatusSchema.nullable(),
    updatedAt: z.string()
  })
  .strict();

export type DiaryEntryDto = z.infer<typeof diaryEntryDtoSchema>;

// One entry in the logical Timeline, discriminated by `kind`. A `diary` row IS a diary Entry (carrying
// its rich body) and a `note` row IS a note Entry — every kind resolves to a real Entry type, so no
// Timeline-only identity exists. The Diary listing is the `kind === "diary"` filter over this result.
export const timelineDiaryEntryDtoSchema = z
  .object({
    bodyDoc: documentJsonSchema,
    bodyText: z.string(),
    entryId: z.string(),
    kind: z.literal("diary"),
    language: z.string().nullable(),
    occurredAt: z.string()
  })
  .strict();

export type TimelineDiaryEntryDto = z.infer<typeof timelineDiaryEntryDtoSchema>;

export const timelineNoteEntryDtoSchema = z
  .object({
    entryId: z.string(),
    kind: z.literal("note"),
    occurredAt: z.string(),
    text: z.string()
  })
  .strict();

export type TimelineNoteEntryDto = z.infer<typeof timelineNoteEntryDtoSchema>;

// A user-owned authored Work in the logical Timeline (#576): the `work` row IS a real `work` Entry the
// user created in the rich editor, carrying its title and the addressable work entry id (so the Timeline
// can deep-link into the editor/reader). Its chronology comes from the shared personal-entry facet, like
// every other Timeline row.
export const timelineWorkEntryDtoSchema = z
  .object({
    entryId: z.string(),
    kind: z.literal("work"),
    occurredAt: z.string(),
    title: z.string(),
    workEntryId: z.string()
  })
  .strict();

export type TimelineWorkEntryDto = z.infer<typeof timelineWorkEntryDtoSchema>;

export const timelineEntryDtoSchema = z.discriminatedUnion("kind", [
  timelineDiaryEntryDtoSchema,
  timelineNoteEntryDtoSchema,
  timelineWorkEntryDtoSchema
]);

export type TimelineEntryDto = z.infer<typeof timelineEntryDtoSchema>;

// The discriminated Timeline kinds, kept in lockstep with the domain vocabulary so a new stored-object
// kind can never appear in the DTO without the domain agreeing.
export const timelineEntryDtoKinds = timelineEntryKinds;

// A day's worth of timeline entries (within a day, newest-first by occurredAt with a stable tie-break).
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

export function parseTimelineEntryDto(value: unknown): TimelineEntryDto {
  return timelineEntryDtoSchema.parse(value);
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
