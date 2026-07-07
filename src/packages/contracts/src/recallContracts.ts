import { z } from "zod";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// The recallable unit's kind. Source-agnostic: a pattern/idiom/proverb/chunk the learner saved
// from reading, or a single word/phrase. Mirrors the `recall_items.kind` enum in the DB schema.
export const recallKinds = ["pattern", "idiom", "proverb", "chunk", "word", "phrase"] as const;

export const recallKindSchema = z.enum(recallKinds);

export type RecallKind = z.infer<typeof recallKindSchema>;

// The fixed, broad category a production-style recall item is filed under (#451). One shallow enum —
// deliberately not a tag taxonomy — so Make Durable can classify a saved item into a single broad
// bucket. Narrow, editable tags (below) refine within a category. Null on legacy/reading/speech items
// that predate Make Durable.
export const recallCategories = [
  "language",
  "work",
  "family",
  "technical",
  "reading",
  "reflection",
  "daily_life"
] as const;

export const recallCategorySchema = z.enum(recallCategories);

export type RecallCategory = z.infer<typeof recallCategorySchema>;

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
    text: z.string().refine(isNonBlank, { message: "text must be non-empty." }),
    // Optional production-style recall metadata (#451). Absent on reading/speech/jot deposits; set when
    // an item is made durable from a Make Durable proposal. NOTE: `sourceProposalCandidateId` is
    // deliberately NOT accepted here — it is an integrity-bearing link that must be validated (the
    // proposal exists, is the user's, and matches the provenance timeline entry), so it is set only by
    // the Make Durable save boundary (`saveProposalRecallItem`), never by a raw enroll client.
    cue: z.string().refine(isNonBlank, { message: "cue must be non-empty." }).nullish(),
    useContext: z
      .string()
      .refine(isNonBlank, { message: "useContext must be non-empty." })
      .nullish(),
    category: recallCategorySchema.nullish(),
    tags: z.array(z.string().refine(isNonBlank, { message: "tag must be non-empty." })).nullish()
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
    text: z.string(),
    // Production-style recall metadata (#451); null on items not made durable from a proposal.
    cue: z.string().nullable(),
    useContext: z.string().nullable(),
    category: recallCategorySchema.nullable(),
    tags: z.array(z.string()).nullable(),
    sourceProposalCandidateId: z.string().nullable()
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

// Input for the deliberate production-style Recall deposit MCP tool (#458): a trusted agent explicitly
// saves ONE production Recall item from observed learning material (e.g. an English-learning mistake),
// without a Make Durable proposal card. `target` is the phrase/pattern to remember (the recall item's
// text); `cue`/`useContext`/`category` make it production-style and are required (non-blank); `tags`,
// `provenanceEntryId`, and `gloss` are optional. `sourceProposalCandidateId` and `chunkId` are
// deliberately NOT accepted — they are integrity-bearing links set only through their own validated
// paths — so a deposit never forges provenance or a proposal link.
export const depositRecallItemToolInputSchema = z
  .object({
    kind: recallKindSchema,
    target: z.string().refine(isNonBlank, { message: "target must be non-empty." }),
    cue: z.string().refine(isNonBlank, { message: "cue must be non-empty." }),
    useContext: z.string().refine(isNonBlank, { message: "useContext must be non-empty." }),
    category: recallCategorySchema,
    tags: z.array(z.string().refine(isNonBlank, { message: "tag must be non-empty." })).nullish(),
    provenanceEntryId: z
      .string()
      .refine(isNonBlank, { message: "provenanceEntryId must be non-empty." })
      .nullish(),
    gloss: z.string().refine(isNonBlank, { message: "gloss must be non-empty." }).nullish()
  })
  .strict();

export type DepositRecallItemToolInput = z.infer<typeof depositRecallItemToolInputSchema>;

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
