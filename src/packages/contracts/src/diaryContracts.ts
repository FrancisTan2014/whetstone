import { type DocumentNodeJSON, documentReadableText, isValidDocument } from "@whetstone/document";
import { isDayKey, timelineEntryKinds } from "@whetstone/domain";
import { z } from "zod";

import { captureInputModeSchema, captureLanguageSchema } from "./captureContracts.js";
import { captureSourceSchema } from "./memoryContracts.js";
import { recitationPhaseDtoSchema } from "./recitationContracts.js";

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

// Typed capture: the web posts the canonical rich document (`bodyDoc`) authored in the shared editor —
// the document crosses the typed-capture boundary intact, never flattened to a plaintext transcript and
// rebuilt (#678). How it was entered is NOT trusted from the client: the server fixes `inputMode = typed`
// for this path (voice capture has its own audio endpoint). No capture language is chosen — typed capture
// needs no language metadata (#647). The server saves the Diary Entry FIRST (before any async tidy), stamps
// occurredAt/createdAt/updatedAt, and derives `bodyText` from the document with the shared readable-text
// projection. A document with no readable text (only structural empty nodes) is rejected here.
export const createDiaryEntryRequestSchema = z
  .object({
    bodyDoc: documentJsonSchema
  })
  .strict()
  .refine((value) => isNonBlank(documentReadableText(value.bodyDoc)), {
    message: "bodyDoc must have readable text.",
    path: ["bodyDoc"]
  });

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
// is ready on write; only the queued voice path carries a status. A `failed` voice capture never reaches
// the Timeline (its empty body is withheld), so a diary Entry surfaces no failure detail here — failure
// categories are exposed by the voice-capture status DTO instead.
export const diaryEntryDtoSchema = z
  .object({
    bodyDoc: documentJsonSchema,
    bodyText: z.string(),
    createdAt: z.string(),
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

// A note in the logical Timeline (#571, #620): the `note` row IS a real `note` Entry — the learner's one
// durable Note, anchored or not. It carries the note's readable body (`text`), how it was captured
// (`captureSource`), and how many retrieval prompts depend on it (`promptCount`, 0 for a note with no
// Memory prompts) — so a former Memory note and a Reader note appear the same way, ONCE, via the shared
// personal-entry chronology. Its prompts, cards, and reviews are deliberately absent here; only the note
// is a Timeline row.
export const timelineNoteEntryDtoSchema = z
  .object({
    captureSource: captureSourceSchema,
    entryId: z.string(),
    kind: z.literal("note"),
    occurredAt: z.string(),
    promptCount: z.number().int().nonnegative(),
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

// A recitation plan in the logical Timeline (#577): the `recitation` row IS a real `recitation_plan`
// Entry the learner adopted, carrying the source Work's title and id (so the Timeline can deep-link into
// the reader) and the current phase. Its chronology comes from the shared personal-entry facet; its
// per-session routine state is deliberately absent here, because a reading session is not a Timeline row.
export const timelineRecitationEntryDtoSchema = z
  .object({
    entryId: z.string(),
    kind: z.literal("recitation"),
    occurredAt: z.string(),
    phase: recitationPhaseDtoSchema,
    title: z.string(),
    workEntryId: z.string()
  })
  .strict();

export type TimelineRecitationEntryDto = z.infer<typeof timelineRecitationEntryDtoSchema>;

export const timelineEntryDtoSchema = z.discriminatedUnion("kind", [
  timelineDiaryEntryDtoSchema,
  timelineNoteEntryDtoSchema,
  timelineWorkEntryDtoSchema,
  timelineRecitationEntryDtoSchema
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

// The lazy-load cursor: page the days strictly before `before` (omitted on the first page), bounded to
// `limit` days. Query params arrive as strings, so `limit` is coerced.
export const timelineQuerySchema = z
  .object({
    before: dayKeySchema.optional(),
    limit: z.coerce.number().int().positive().max(100).optional()
  })
  .strict();

export type TimelineQuery = z.infer<typeof timelineQuerySchema>;

export function parseDiaryEntryDto(value: unknown): DiaryEntryDto {
  return diaryEntryDtoSchema.parse(value);
}

export function parseTimelineDto(value: unknown): TimelineDto {
  return timelineDtoSchema.parse(value);
}

export function parseTimelineEntryDto(value: unknown): TimelineEntryDto {
  return timelineEntryDtoSchema.parse(value);
}

export function parseCreateDiaryEntryRequest(value: unknown): CreateDiaryEntryRequest {
  return createDiaryEntryRequestSchema.parse(value);
}

export function parseUpdateDiaryEntryRequest(value: unknown): UpdateDiaryEntryRequest {
  return updateDiaryEntryRequestSchema.parse(value);
}
