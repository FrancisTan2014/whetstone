import { z } from "zod";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The recallable unit's kind. Source-agnostic: a pattern/idiom/proverb/chunk the learner saved
// from reading, or a single word/phrase. Mirrors the `recall_items.kind` enum in the DB schema.
export const recallKinds = ["pattern", "idiom", "proverb", "chunk", "word", "phrase"] as const;

export const recallKindSchema = z.enum(recallKinds);

export type RecallKind = z.infer<typeof recallKindSchema>;

// Enroll request: what the learner (or an LLM) supplies to save an item. It NEVER supplies the
// owning user (the server resolves the current user) nor the review state (the scheduler seeds it).
// `provenanceEntryId` optionally links the item to the source note/block it came from; absent/null
// when jotted or LLM-supplied.
export const enrollRecallItemRequestSchema = z
  .object({
    chunkId: z.string().refine(isNonBlank, { message: "chunkId must be non-empty." }).nullish(),
    gloss: z.string().refine(isNonBlank, { message: "gloss must be non-empty." }).nullish(),
    kind: recallKindSchema,
    provenanceEntryId: z
      .string()
      .refine(isNonBlank, { message: "provenanceEntryId must be non-empty." })
      .nullish(),
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." })
  })
  .strict();

export type EnrollRecallItemRequest = z.infer<typeof enrollRecallItemRequestSchema>;

// The SM-2 review state carried by an item (ISO-8601 instants; `lastReviewedAt` null until the
// first review). Structurally the domain `ReviewState`.
export const reviewStateDtoSchema = z
  .object({
    dueAt: z.string(),
    easeFactor: z.number(),
    intervalDays: z.number().int(),
    lapses: z.number().int(),
    lastReviewedAt: z.string().nullable(),
    repetitions: z.number().int()
  })
  .strict();

export type ReviewStateDto = z.infer<typeof reviewStateDtoSchema>;

export const recallItemDtoSchema = z
  .object({
    chunkId: z.string().nullable(),
    createdAt: z.string(),
    gloss: z.string().nullable(),
    id: z.string(),
    kind: recallKindSchema,
    provenanceEntryId: z.string().nullable(),
    review: reviewStateDtoSchema,
    text: z.string()
  })
  .strict();

export type RecallItemDto = z.infer<typeof recallItemDtoSchema>;

// Record a review: the grade (SM-2 0..5, or an Again/Hard/Good/Easy mapped to it upstream). The
// item, user, and time are not part of the body — the server resolves them.
export const recordRecallReviewRequestSchema = z
  .object({
    grade: z.number().int().min(0).max(5)
  })
  .strict();

export type RecordRecallReviewRequest = z.infer<typeof recordRecallReviewRequestSchema>;

export const recallItemListDtoSchema = z.object({ items: z.array(recallItemDtoSchema) }).strict();

export type RecallItemListDto = z.infer<typeof recallItemListDtoSchema>;

// Input schemas for the MCP recall tools (#190). They live here so the MCP layer validates with the
// same shared contracts the rest of the app uses. `save_recall_item` reuses
// `enrollRecallItemRequestSchema`; the rest are below.
export const listDueItemsToolInputSchema = z
  .object({ limit: z.number().int().positive().optional() })
  .strict();

export type ListDueItemsToolInput = z.infer<typeof listDueItemsToolInputSchema>;

export const recordReviewToolInputSchema = z
  .object({
    grade: z.number().int().min(0).max(5),
    itemId: z.string().refine(isNonBlank, { message: "itemId must be non-empty." })
  })
  .strict();

export type RecordReviewToolInput = z.infer<typeof recordReviewToolInputSchema>;

export const searchRecallItemsToolInputSchema = z.object({ query: z.string() }).strict();

export type SearchRecallItemsToolInput = z.infer<typeof searchRecallItemsToolInputSchema>;

export const getRecallItemToolInputSchema = z
  .object({ id: z.string().refine(isNonBlank, { message: "id must be non-empty." }) })
  .strict();

export type GetRecallItemToolInput = z.infer<typeof getRecallItemToolInputSchema>;

export function parseEnrollRecallItemRequest(value: unknown): EnrollRecallItemRequest {
  return enrollRecallItemRequestSchema.parse(value);
}

export function parseRecordRecallReviewRequest(value: unknown): RecordRecallReviewRequest {
  return recordRecallReviewRequestSchema.parse(value);
}

export function parseRecallItemDto(value: unknown): RecallItemDto {
  return recallItemDtoSchema.parse(value);
}

export function parseRecallItemListDto(value: unknown): RecallItemListDto {
  return recallItemListDtoSchema.parse(value);
}
