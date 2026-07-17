import { captureSources } from "@whetstone/domain";
import { type DocumentNodeJSON, isValidDocument } from "@whetstone/document";
import { z } from "zod";

// Shared review/capture primitives (historical filename retained per the Memory retirement, #662 — the
// standalone Memory surface is gone, but these small enums/DTOs are the review substrate the Notes-owned
// Review session, the diary capture facet, and the shared FSRS scheduler all still speak). No Memory
// note/prompt/deposit request or MCP tool-input contract lives here anymore; those were removed with the
// Memory experience.

// A ProseMirror/Tiptap document, validated against the shared document schema so a malformed or unsafe
// question/answer body never reaches storage. Typed as `DocumentNodeJSON` for consumers.
export const memoryDocumentSchema = z.custom<DocumentNodeJSON>(isValidDocument, {
  message: "must be a valid document."
});

// How an owned Entry was captured (manual, import, tool, …). Shared by the diary/notes capture facet.
export const captureSourceSchema = z.enum(captureSources);

// The FSRS card state a scheduled prompt carries (#595). ISO-8601 `due`/`lastReviewedAt` (the latter null
// until the first review); the rest are the FSRS card fields the scheduler round-trips. Structurally equal
// to the domain `ReviewState`.
export const reviewStateDtoSchema = z
  .object({
    due: z.string().datetime(),
    stability: z.number(),
    difficulty: z.number(),
    elapsedDays: z.number().int(),
    scheduledDays: z.number().int(),
    learningSteps: z.number().int(),
    reps: z.number().int(),
    lapses: z.number().int(),
    state: z.enum(["new", "learning", "review", "relearning"]),
    lastReviewedAt: z.string().datetime().nullable()
  })
  .strict();

export type ReviewStateDto = z.infer<typeof reviewStateDtoSchema>;

// The learner's four-button FSRS rating, shared by every review surface (Notes-owned Review, Recitation).
export const ratingSchema = z.enum(["again", "hard", "good", "easy"]);
