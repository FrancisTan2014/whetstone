import { type DocumentNodeJSON, isValidDocument } from "@whetstone/document";
import { z } from "zod";

import { ratingSchema, reviewStateDtoSchema } from "./memoryContracts.js";

// A ProseMirror/Tiptap document projected on the wire (the rich cue, note body, or legacy custom answer),
// validated against the shared document schema so a malformed body never crosses the boundary.
const noteReviewDocumentSchema = z.custom<DocumentNodeJSON>(isValidDocument, {
  message: "must be a valid document."
});

// The persisted reveal discriminant a Notes-owned review prompt declares (#657). `current_note` resolves
// the referenced note's live canonical body; `legacy_custom` resolves the prompt's own preserved custom
// answer. A consumer switches on this — never on nullable answer fields.
export const noteRevealKindSchema = z.enum(["current_note", "legacy_custom"]);

export type NoteRevealKind = z.infer<typeof noteRevealKindSchema>;

// The one earliest-due prompt a Notes-owned session presents BEFORE reveal (#657): its identity, the rich
// cue (question) and its readable projection, the reveal discriminant, and the card's current FSRS state.
// It deliberately carries NO answer/reveal content — the reveal is fetched separately when the learner
// activates "Show note", so the question phase cannot leak the answer.
export const noteReviewPromptDtoSchema = z
  .object({
    promptId: z.string(),
    noteId: z.string(),
    cueDoc: noteReviewDocumentSchema,
    cueText: z.string(),
    revealKind: noteRevealKindSchema,
    review: reviewStateDtoSchema
  })
  .strict();

export type NoteReviewPromptDto = z.infer<typeof noteReviewPromptDtoSchema>;

// The next-due response: the single earliest-due active prompt, or null when nothing is due (the calm
// "due complete" state). No queue or cursor is persisted — a refresh recomputes this from the cards.
export const noteReviewNextDtoSchema = z
  .object({ prompt: noteReviewPromptDtoSchema.nullable() })
  .strict();

export type NoteReviewNextDto = z.infer<typeof noteReviewNextDtoSchema>;

// The resolved reveal, discriminated by the persisted `kind` so a consumer never infers the reveal shape
// from nullable answer fields (#657): a `current_note` reveal is the note's live canonical rich body; a
// `legacy_custom` reveal is the prompt's own preserved rich custom answer. Exactly one shape is present.
export const noteRevealDtoSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("current_note"),
      bodyDoc: noteReviewDocumentSchema,
      bodyText: z.string()
    })
    .strict(),
  z
    .object({
      kind: z.literal("legacy_custom"),
      answerDoc: noteReviewDocumentSchema,
      answerText: z.string()
    })
    .strict()
]);

export type NoteRevealDto = z.infer<typeof noteRevealDtoSchema>;

// Rate one prompt in the session (#657): the learner's four-button FSRS rating. The prompt, user, and
// time are resolved by the server, not part of the body.
export const noteReviewRatingRequestSchema = z.object({ rating: ratingSchema }).strict();

export type NoteReviewRatingRequest = z.infer<typeof noteReviewRatingRequestSchema>;

// The result of rating a prompt: the rescheduled card's next FSRS state, whose `due` is the next
// scheduled date the session shows. Only that one prompt's card is rescheduled.
export const noteReviewRatingResultDtoSchema = z.object({ review: reviewStateDtoSchema }).strict();

export type NoteReviewRatingResultDto = z.infer<typeof noteReviewRatingResultDtoSchema>;

export function parseNoteReviewNextDto(value: unknown): NoteReviewNextDto {
  return noteReviewNextDtoSchema.parse(value);
}

export function parseNoteReviewPromptDto(value: unknown): NoteReviewPromptDto {
  return noteReviewPromptDtoSchema.parse(value);
}

export function parseNoteRevealDto(value: unknown): NoteRevealDto {
  return noteRevealDtoSchema.parse(value);
}

export function parseNoteReviewRatingRequest(value: unknown): NoteReviewRatingRequest {
  return noteReviewRatingRequestSchema.parse(value);
}

export function parseNoteReviewRatingResultDto(value: unknown): NoteReviewRatingResultDto {
  return noteReviewRatingResultDtoSchema.parse(value);
}
