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
// custom), its optimistic content revision, and its projected card state. The list is ordered by creation
// so a note with several legacy prompts reads stably. It carries the question (editable) but never a
// `current_note` reveal body — that lives on the note — so the settings view cannot drift from the
// canonical note. Question / grading-target writes echo `revision` as `expectedRevision`; stale editors get
// a named conflict instead of overwriting newer work.
export const notePromptSettingsDtoSchema = z
  .object({
    promptId: z.string(),
    revision: z.number().int().nonnegative(),
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

// Editing a prompt's retrieval question from Card detail (#660, #687): the new question as a rich document,
// authored with the same retrieval-contract editor as first-card authoring. Its readable text is derived
// server-side (never trusted from the client), which is also the non-blank gate — a question that renders to
// only whitespace is rejected there, not here. Editing writes ONLY the cue — it never touches the prompt's
// reveal policy, its card, its FSRS state, its due date, its requested retention, or its history.
// `expectedRevision` is the settings row loaded by the editor and makes the write compare-and-swap.
export const editNotePromptQuestionRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    questionDoc: noteReviewDocumentSchema
  })
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
// changed — the learner declares it. A cardless prompt accepts only `keep`. `expectedRevision` protects
// both policy-only and policy-plus-reset writes from replacing a newer Question or grading target.
export const setNoteGradingTargetRequestSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mode: z.enum(["keep", "restart"]),
    target: noteGradingTargetSchema
  })
  .strict();

export type SetNoteGradingTargetRequest = z.infer<typeof setNoteGradingTargetRequestSchema>;

// Create one review card directly from an authored question/answer pair (#689), retry-safe via the
// client's stable `submissionId`. `questionDoc` is the rich retrieval prompt; `answerDoc` is the rich body
// of the standalone note the card reviews; `target` is the discriminated grading policy (grade against the
// live note, or against an authored Success check). Every readable text (Question, Answer, Reference,
// Success check) is derived from these documents server-side — the wire never carries client plaintext, so
// a caller can neither desynchronize the projections nor smuggle a Reference into the Success check. A
// blank document (one whose derived text is only whitespace) is rejected server-side, not here.
export const createDirectCardRequestSchema = z
  .object({
    submissionId: z.string().trim().min(1),
    questionDoc: noteReviewDocumentSchema,
    answerDoc: noteReviewDocumentSchema,
    target: noteGradingTargetSchema
  })
  .strict();

export type CreateDirectCardRequest = z.infer<typeof createDirectCardRequestSchema>;

// The result of a retry-safe direct card creation (#689): the created standalone note's id, the created
// prompt's id, and the complete FSRS state of the freshly seeded shared review card (due now, at the recall
// retention). A replay of the same submission returns this SAME result untouched, so the follow-on composer
// (#690) can rely on identical ids/state whether it is the first call or a retry.
export const directCardResultDtoSchema = z
  .object({
    noteId: z.string(),
    promptId: z.string(),
    review: reviewStateDtoSchema
  })
  .strict();

export type DirectCardResultDto = z.infer<typeof directCardResultDtoSchema>;

// Author a rich review card for an already-saved, owned note from its Cards list (#687; independent
// directions in #688), retry-safe via the client's stable `submissionId`. Unlike #689's createDirectCard —
// which mints a NEW standalone note to review — this applies a retrieval contract to an EXISTING owned note:
// the note itself is the reviewed material, so there is no `answerDoc` and the note is never copied or
// rewritten. `noteEntryId` is the owned note; `questionDoc` is the rich retrieval prompt (its readable text
// derived server-side, where the non-blank gate is applied); `target` is the discriminated grading policy
// (grade against the live note, or against an authored Success check). A note may own MANY authored prompts,
// so a DIFFERENT submission always creates a new independently-scheduled card; idempotency is per
// `submissionId` (a same-id replay returns the original result, a changed-payload replay is a named
// conflict), never a note-uniqueness constraint. The result reuses `directCardResultDtoSchema` — the created
// prompt/card ids plus the seeded FSRS state — with `noteId` being the existing owned note.
export const authorNoteCardRequestSchema = z
  .object({
    submissionId: z.string().trim().min(1),
    noteEntryId: z.string().trim().min(1),
    questionDoc: noteReviewDocumentSchema,
    target: noteGradingTargetSchema
  })
  .strict();

export type AuthorNoteCardRequest = z.infer<typeof authorNoteCardRequestSchema>;

export function parseAuthorNoteCardRequest(value: unknown): AuthorNoteCardRequest {
  return authorNoteCardRequestSchema.parse(value);
}

export function parseCreateDirectCardRequest(value: unknown): CreateDirectCardRequest {
  return createDirectCardRequestSchema.parse(value);
}

export function parseDirectCardResultDto(value: unknown): DirectCardResultDto {
  return directCardResultDtoSchema.parse(value);
}

// One reviewed existing-material candidate the New-card save surfaced (#712): the owned note whose exact
// semantic material equals the drafted Answer. `answerExcerpt` is a short readable projection of that
// note's body (derived server-side, never trusted from the client); `sourceContext` is the note's anchor
// selected-text snapshot when it is anchored to a Work, else null; `cardCount` is how many review cards
// the note already owns. It is FACTUAL evidence that the material exists — never a "duplicate" verdict and
// never ordered/preselected by recency, source, or card count; the learner decides.
export const materialReviewCandidateDtoSchema = z
  .object({
    answerExcerpt: z.string(),
    cardCount: z.number().int().nonnegative(),
    noteId: z.string(),
    sourceContext: z.string().nullable()
  })
  .strict();

export type MaterialReviewCandidateDto = z.infer<typeof materialReviewCandidateDtoSchema>;

// One concise, factual word-level difference between a near-match candidate note and the drafted Answer
// (#714): the candidate's wording (`before`) against the draft's (`after`). An empty `before` is a word the
// draft added; an empty `after` is a word the candidate has that the draft dropped; both non-empty is a
// changed word (e.g. `terms` → `term`). Derived server-side from the normalized keys — never a similarity
// score and never trusted from the client — so the panel renders it without recomputing eligibility.
export const nearMatchDifferenceDtoSchema = z
  .object({ before: z.string(), after: z.string() })
  .strict();

export type NearMatchDifferenceDto = z.infer<typeof nearMatchDifferenceDtoSchema>;

// One high-precision NEAR-match candidate the New-card review surfaced under "Possible duplicate" (#714): an
// owned note whose material is very similar prose to the drafted Answer but NOT identical (an exact match is
// its own group). It carries the same factual evidence as an exact candidate — a readable Answer excerpt,
// the anchor source context when anchored, and how many cards the note already owns — PLUS the concrete word
// `differences` so the learner can compare meaning. It is never a "duplicate" verdict, never ordered or
// preselected by anything a learner sees, and the fuzzy score is never exposed.
export const nearMaterialReviewCandidateDtoSchema = z
  .object({
    answerExcerpt: z.string(),
    cardCount: z.number().int().nonnegative(),
    differences: z.array(nearMatchDifferenceDtoSchema),
    noteId: z.string(),
    sourceContext: z.string().nullable()
  })
  .strict();

export type NearMaterialReviewCandidateDto = z.infer<typeof nearMaterialReviewCandidateDtoSchema>;

// The full owner-scoped material review a New-card save returns when the drafted Answer already exists in
// Notes, exactly or as a high-precision near match (#712, #714): the opaque attempt id and its revision
// fence (echoed on a decision), two SEPARATE typed candidate groups — `candidates` (exact material already
// in Notes) and `nearCandidates` ("Possible duplicate": very similar wording, with factual differences) —
// and their `candidateFingerprint` so a client can notice the reviewed evidence changed. The fingerprint
// binds BOTH groups plus the near evidence-policy version, so any new/changed/deleted candidate in either
// group refreshes review. The server always rechecks in the decision transaction, so this fingerprint is
// advisory. Carries no draft content and no server key.
export const materialReviewDtoSchema = z
  .object({
    attemptId: z.string(),
    candidateFingerprint: z.string(),
    candidates: z.array(materialReviewCandidateDtoSchema),
    nearCandidates: z.array(nearMaterialReviewCandidateDtoSchema),
    revision: z.number().int().nonnegative()
  })
  .strict();

export type MaterialReviewDto = z.infer<typeof materialReviewDtoSchema>;

// The discriminated result of a New-card save (#712, wrapping #689). `created` minted a fresh standalone
// note + prompt + card (no matching material existed); `reused` — reachable only via a decision — added the
// drafted contract to an existing note; `needs_material_review` created nothing and returned the review so
// the learner can decide. The `created`/`reused` payloads reuse `directCardResultDtoSchema` so the follow-on
// composer can rely on identical ids/state whether the save created directly or a decision resolved it.
export const directCardSaveResultDtoSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("created"), result: directCardResultDtoSchema }).strict(),
  z.object({ status: z.literal("reused"), result: directCardResultDtoSchema }).strict(),
  z.object({ status: z.literal("needs_material_review"), review: materialReviewDtoSchema }).strict()
]);

export type DirectCardSaveResultDto = z.infer<typeof directCardSaveResultDtoSchema>;

export function parseDirectCardSaveResultDto(value: unknown): DirectCardSaveResultDto {
  return directCardSaveResultDtoSchema.parse(value);
}

// The advisory exact-material query (#712): the client debounces this over a valid non-blank Answer draft to
// warn "This material is already in Notes" before save. It is READ-ONLY and never authoritative — the save
// always reprojects and rechecks in its transaction — so a stale or missed hint can never change what is
// created. Only the Answer document is sent; its material is projected server-side.
export const exactMaterialQueryRequestSchema = z
  .object({ answerDoc: noteReviewDocumentSchema })
  .strict();

export type ExactMaterialQueryRequest = z.infer<typeof exactMaterialQueryRequestSchema>;

// The advisory material query (#712, #714): the client debounces this over a valid non-blank Answer draft to
// warn before save. It is READ-ONLY and never authoritative — the save always reprojects and rechecks in its
// transaction — so a stale or missed hint can never change what is created. Only the Answer document is sent;
// its exact material and near-match candidates are both projected server-side and returned as separate typed
// groups.
export const exactMaterialQueryResponseSchema = z
  .object({
    candidates: z.array(materialReviewCandidateDtoSchema),
    nearCandidates: z.array(nearMaterialReviewCandidateDtoSchema)
  })
  .strict();

export type ExactMaterialQueryResponse = z.infer<typeof exactMaterialQueryResponseSchema>;

export function parseExactMaterialQueryRequest(value: unknown): ExactMaterialQueryRequest {
  return exactMaterialQueryRequestSchema.parse(value);
}

export function parseExactMaterialQueryResponse(value: unknown): ExactMaterialQueryResponse {
  return exactMaterialQueryResponseSchema.parse(value);
}

// Use existing material (#712): the learner chose one reviewed candidate note to receive the drafted
// retrieval contract instead of minting a new note. It carries the SAME full draft the save posted (so the
// server recomputes the draft fingerprint and rejects an edited Answer as a changed payload), the opaque
// `attemptId` + `revision` fence, the client's stable `submissionId` (so the composed add-card write is
// retry-safe), and the chosen `noteEntryId` (which must be a candidate the review surfaced and still
// exist). React never submits a canonical key or bypass flag — only the real documents.
export const useExistingMaterialRequestSchema = z
  .object({
    submissionId: z.string().trim().min(1),
    attemptId: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    noteEntryId: z.string().trim().min(1),
    questionDoc: noteReviewDocumentSchema,
    answerDoc: noteReviewDocumentSchema,
    target: noteGradingTargetSchema
  })
  .strict();

export type UseExistingMaterialRequest = z.infer<typeof useExistingMaterialRequestSchema>;

// Keep separate (#712): the learner deliberately commits distinct material despite the review. It carries
// the SAME full draft, the `attemptId` + `revision` fence, and the `submissionId`. The server reacquires the
// lock and rechecks: a new/changed/deleted candidate refreshes review; otherwise it creates through the
// canonical direct-card writer.
export const keepSeparateMaterialRequestSchema = z
  .object({
    submissionId: z.string().trim().min(1),
    attemptId: z.string().trim().min(1),
    revision: z.number().int().nonnegative(),
    questionDoc: noteReviewDocumentSchema,
    answerDoc: noteReviewDocumentSchema,
    target: noteGradingTargetSchema
  })
  .strict();

export type KeepSeparateMaterialRequest = z.infer<typeof keepSeparateMaterialRequestSchema>;

export function parseUseExistingMaterialRequest(value: unknown): UseExistingMaterialRequest {
  return useExistingMaterialRequestSchema.parse(value);
}

export function parseKeepSeparateMaterialRequest(value: unknown): KeepSeparateMaterialRequest {
  return keepSeparateMaterialRequestSchema.parse(value);
}

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
