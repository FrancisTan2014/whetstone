import { type DocumentNodeJSON, isValidDocument } from "@whetstone/document";
import { z } from "zod";

import { ratingSchema, reviewStateDtoSchema } from "./memoryContracts.js";

// A ProseMirror/Tiptap document projected on the wire (the rich cue, note body, or legacy custom answer),
// validated against the shared document schema so a malformed body never crosses the boundary.
const noteReviewDocumentSchema = z.custom<DocumentNodeJSON>(isValidDocument, {
  message: "must be a valid document."
});

// The persisted reveal discriminant a Notes-owned review prompt declares (#657, #686). `current_note`
// resolves the referenced note's live canonical body; `expected_response` grades against one authored rich
// Success check and additionally resolves the live note as Reference; `legacy_custom` resolves the prompt's
// own preserved custom answer. A consumer switches on this — never on nullable answer fields.
export const noteRevealKindSchema = z.enum(["current_note", "expected_response", "legacy_custom"]);

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
// from nullable answer fields (#657, #686): a `current_note` reveal is the note's live canonical rich body;
// an `expected_response` reveal is the authored rich Success check (`successCheck*`) PLUS the live note as
// Reference (`reference*`) — two separately labeled documents, never conflated under the storage-column
// name `answerDoc`; a `legacy_custom` reveal is the prompt's own preserved rich custom answer. Exactly one
// shape is present.
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
      kind: z.literal("expected_response"),
      successCheckDoc: noteReviewDocumentSchema,
      successCheckText: z.string(),
      referenceDoc: noteReviewDocumentSchema,
      referenceText: z.string()
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

// The result of rating a prompt: the rescheduled card's next FSRS state (whose `due` is the next scheduled
// date the session shows) and `remainingDue` — the count of the learner's still-due prompts AFTER this
// rating. The session reads `remainingDue` to truthfully report completion the moment the final due prompt
// is rated, rather than requiring an extra "Review next" click (#657). Only that one prompt's card is
// rescheduled.
export const noteReviewRatingResultDtoSchema = z
  .object({ review: reviewStateDtoSchema, remainingDue: z.number().int().nonnegative() })
  .strict();

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

// The objective review state the note sheet shows for a saved note (#658), discriminated by `status` so
// the sheet renders on the persisted fact, never inferring from loose fields. `not_enrolled` offers the
// "Add to review" control; `due` is enrolled and due now (offering "Review"); `scheduled` carries the
// next review instant to localize as "Next review · <date>"; `paused` is enrolled but withheld from the
// due scan. Only `scheduled` carries a date — a due card shows "Due now" and a paused card shows "Paused".
// `not_enrolled` may carry a `question`: an imported note (#661) already owns a confirmed, cardless
// current-note prompt, so its stored question is surfaced for the UI to show read-only and reuse on
// "Add to review" instead of asking the learner to retype it. It is absent when no prompt exists yet.
export const noteReviewEnrollmentStatusDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_enrolled"), question: z.string().min(1).optional() }).strict(),
  z.object({ status: z.literal("due") }).strict(),
  z.object({ status: z.literal("scheduled"), nextReviewAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("paused") }).strict()
]);

export type NoteReviewEnrollmentStatusDto = z.infer<typeof noteReviewEnrollmentStatusDtoSchema>;

export function parseNoteReviewEnrollmentStatusDto(value: unknown): NoteReviewEnrollmentStatusDto {
  return noteReviewEnrollmentStatusDtoSchema.parse(value);
}

// The single Review projection each row of the Notes home shows (#659), rolled up ONCE across all of a
// note's prompt/cards with a fixed precedence so a note with several legacy prompts still shows one calm
// state: any active due card → `due` with the due `count`; otherwise the earliest active future card →
// `scheduled` with that instant; otherwise a paused-only card → `paused`; otherwise `not_enrolled`
// (offering "Add to review"). Unlike the per-card enrollment status, `due` carries the count so the list
// can show "Review due (N)". It is a derived projection joined onto the note, never persisted on it.
export const noteReviewSummaryDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_enrolled") }).strict(),
  z.object({ status: z.literal("due"), dueCount: z.number().int().positive() }).strict(),
  z.object({ status: z.literal("scheduled"), nextReviewAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal("paused") }).strict()
]);

export type NoteReviewSummaryDto = z.infer<typeof noteReviewSummaryDtoSchema>;

export function parseNoteReviewSummaryDto(value: unknown): NoteReviewSummaryDto {
  return noteReviewSummaryDtoSchema.parse(value);
}

// Adding a saved note to Review from the Notes home (#659). An anchored note reuses its exact source as the
// question server-side and carries no body; a standalone note has no source, so the learner supplies the
// question ("What should Whetstone ask you?") — a required, non-blank string. The field is optional on the
// wire because the anchored path omits it; the server rejects a standalone enrollment that carries none.
export const enrollNoteRequestSchema = z
  .object({ question: z.string().trim().min(1).optional() })
  .strict();

export type EnrollNoteRequest = z.infer<typeof enrollNoteRequestSchema>;

export function parseEnrollNoteRequest(value: unknown): EnrollNoteRequest {
  return enrollNoteRequestSchema.parse(value);
}

// The projected Review state of a single prompt's card, as the Notes-owned Review settings list shows it
// (#660), discriminated by `state` so a row renders on the persisted fact and never infers from loose
// fields. `not_in_review` has no card and offers "Add to review"; `due` is an active card due now (offering
// "Review"); `scheduled` carries the next review instant to localize as "Next review · <date>"; `paused` is
// enrolled but withheld from the due scan. Only `scheduled` carries a date. It is derived per request from
// the card, never persisted on the prompt.
export const notePromptCardStateDtoSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_in_review") }).strict(),
  z.object({ state: z.literal("due") }).strict(),
  z.object({ state: z.literal("scheduled"), nextReviewAt: z.string().datetime() }).strict(),
  z.object({ state: z.literal("paused") }).strict()
]);

export type NotePromptCardStateDto = z.infer<typeof notePromptCardStateDtoSchema>;

// How a prompt reveals its answer, as the settings list declares it (#660, #686), discriminated by the
// persisted `kind`. A `current_note` prompt follows the note's live canonical body — it carries no answer
// content because editing the note edits the reveal. An `expected_response` prompt carries its authored rich
// Success check (`successCheck*`) so the settings row can render it; its Reference is the live note and is
// not copied here. A `legacy_custom` prompt preserves its own rich custom answer, carried here so the
// settings row can render it READ-ONLY (#657: legacy reveals are never editable or converted). A consumer
// switches on `kind`, never on nullable answer fields.
export const notePromptRevealPolicyDtoSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_note") }).strict(),
  z
    .object({
      kind: z.literal("expected_response"),
      successCheckDoc: noteReviewDocumentSchema,
      successCheckText: z.string()
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

export type NotePromptRevealPolicyDto = z.infer<typeof notePromptRevealPolicyDtoSchema>;

// One row of the Notes-owned Review settings list (#660): a prompt's identity, its editable retrieval
// question (the rich cue and its readable projection), its reveal policy (current-note vs read-only legacy
// custom), and its projected card state. The list is ordered by creation so a note with several legacy
// prompts reads stably. It carries the question (editable) but never a `current_note` reveal body — that
// lives on the note — so the settings view cannot drift from the canonical note.
export const notePromptSettingsDtoSchema = z
  .object({
    promptId: z.string(),
    questionDoc: noteReviewDocumentSchema,
    questionText: z.string(),
    reveal: notePromptRevealPolicyDtoSchema,
    cardState: notePromptCardStateDtoSchema
  })
  .strict();

export type NotePromptSettingsDto = z.infer<typeof notePromptSettingsDtoSchema>;

// The full Review settings projection for one note (#660): every prompt owned by the note, in creation
// order. A refresh recomputes it from the prompts and their cards; nothing here is persisted as a rollup.
export const notePromptSettingsListDtoSchema = z
  .object({ prompts: z.array(notePromptSettingsDtoSchema) })
  .strict();

export type NotePromptSettingsListDto = z.infer<typeof notePromptSettingsListDtoSchema>;

// One entry of a prompt's append-only Review history (#660), discriminated by `kind` so a consumer renders
// on the persisted fact: a `rating` is a graded review (its four-button FSRS rating localized as
// Again/Hard/Good/Easy); a `reset` is a schedule restart ("Schedule restarted"). Every entry carries its
// identity and the instant it occurred. History records only real card events — never a synthetic entry for
// reveal, pause, resume, enrollment, or removal — and outlives the card, so removing and re-adding a prompt
// never erases it.
export const reviewHistoryEventDtoSchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string(),
      kind: z.literal("rating"),
      rating: ratingSchema,
      occurredAt: z.string().datetime()
    })
    .strict(),
  z.object({ id: z.string(), kind: z.literal("reset"), occurredAt: z.string().datetime() }).strict()
]);

export type ReviewHistoryEventDto = z.infer<typeof reviewHistoryEventDtoSchema>;

// One page of a prompt's Review history (#660): the newest events first (occurred_at desc, id desc as the
// stable tiebreak) and an opaque `nextCursor` to load older ones, or null at the end. The cursor is opaque
// so the client never constructs a query from raw columns — it just echoes what the server handed back.
export const reviewHistoryPageDtoSchema = z
  .object({
    events: z.array(reviewHistoryEventDtoSchema),
    nextCursor: z.string().nullable()
  })
  .strict();

export type ReviewHistoryPageDto = z.infer<typeof reviewHistoryPageDtoSchema>;

// Editing a prompt's retrieval question from Review settings (#660): the new question as a required,
// non-blank string. Editing writes ONLY the cue — it never touches the prompt's reveal policy, its card, its
// FSRS state, its due date, its requested retention, or its history.
export const editNotePromptQuestionRequestSchema = z
  .object({ question: z.string().trim().min(1) })
  .strict();

export type EditNotePromptQuestionRequest = z.infer<typeof editNotePromptQuestionRequestSchema>;

// The authored grading target a prompt should adopt (#686), discriminated by `kind`. `current_note` grades
// against the live note body and carries no authored content. `expected_response` grades against one
// authored rich Success check, supplied here as a document; its readable text is derived server-side (never
// trusted from the client) and the Reference is resolved live from the note, so it is not carried. The
// wire never uses the storage-column name `answerDoc`, which would conflate the Success check with the
// Reference.
export const noteGradingTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current_note") }).strict(),
  z
    .object({ kind: z.literal("expected_response"), successCheckDoc: noteReviewDocumentSchema })
    .strict()
]);

export type NoteGradingTarget = z.infer<typeof noteGradingTargetSchema>;

// Set a prompt's grading target from Review settings (#686). `target` is the desired grading policy;
// `mode` explicitly chooses what happens to the card: `keep` saves the policy without touching card state,
// due date, requested retention, or history; `restart` additionally resets the schedule through the shared
// Review boundary (one `reset` event, due now). Whetstone never infers whether the trained capability
// changed — the learner declares it. A cardless prompt accepts only `keep`.
export const setNoteGradingTargetRequestSchema = z
  .object({ mode: z.enum(["keep", "restart"]), target: noteGradingTargetSchema })
  .strict();

export type SetNoteGradingTargetRequest = z.infer<typeof setNoteGradingTargetRequestSchema>;

export function parseNotePromptSettingsListDto(value: unknown): NotePromptSettingsListDto {
  return notePromptSettingsListDtoSchema.parse(value);
}

export function parseNotePromptSettingsDto(value: unknown): NotePromptSettingsDto {
  return notePromptSettingsDtoSchema.parse(value);
}

export function parseReviewHistoryPageDto(value: unknown): ReviewHistoryPageDto {
  return reviewHistoryPageDtoSchema.parse(value);
}

export function parseEditNotePromptQuestionRequest(value: unknown): EditNotePromptQuestionRequest {
  return editNotePromptQuestionRequestSchema.parse(value);
}

export function parseSetNoteGradingTargetRequest(value: unknown): SetNoteGradingTargetRequest {
  return setNoteGradingTargetRequestSchema.parse(value);
}
