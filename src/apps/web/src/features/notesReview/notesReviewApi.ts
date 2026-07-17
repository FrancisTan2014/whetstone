import {
  parseNotePromptSettingsDto,
  parseNotePromptSettingsListDto,
  parseNoteRevealDto,
  parseNoteReviewEnrollmentStatusDto,
  parseNoteReviewNextDto,
  parseNoteReviewRatingResultDto,
  parseReviewHistoryPageDto,
  type NotePromptSettingsDto,
  type NotePromptSettingsListDto,
  type NoteReviewEnrollmentStatusDto,
  type NoteReviewPromptDto,
  type NoteRevealDto,
  type NoteReviewRatingResultDto,
  type ReviewHistoryPageDto
} from "@whetstone/contracts";
import { type ReviewRating } from "@whetstone/domain";

import { apiUrl } from "../../shared/runtime";

// The Notes-owned Review session keeps its own fetch helper so it stays decoupled from other features.
// Every response is parsed through the shared contracts schema, so a drifted server shape is caught at the
// boundary rather than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
  return response.json();
}

// The single earliest-due prompt (question phase only), or null when nothing is due — the calm
// "due complete" state. Recomputed each call; no queue or cursor is persisted.
export async function fetchNextNotePrompt(): Promise<NoteReviewPromptDto | null> {
  return parseNoteReviewNextDto(await requestJson(apiUrl("/notes/review/next"))).prompt;
}

// Resolve one prompt's reveal — the current canonical note body or the preserved legacy custom answer.
// Fetched only when the learner activates "Show note", so the question phase never carries the answer.
export async function fetchNoteReveal(promptId: string): Promise<NoteRevealDto> {
  return parseNoteRevealDto(
    await requestJson(apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/reveal`))
  );
}

// Rate one prompt: the learner's Again/Hard/Good/Easy rating advances only that prompt's shared card and
// returns its next scheduled state.
export async function rateNotePrompt(
  promptId: string,
  rating: ReviewRating
): Promise<NoteReviewRatingResultDto> {
  return parseNoteReviewRatingResultDto(
    await requestJson(apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/rating`), {
      body: JSON.stringify({ rating }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// One saved note's current Review status, for the note sheet's Review section: not enrolled, due now,
// scheduled for a future date, or paused. A read; it changes nothing.
export async function fetchNoteReviewStatus(
  workEntryId: string,
  noteEntryId: string
): Promise<NoteReviewEnrollmentStatusDto> {
  return parseNoteReviewEnrollmentStatusDto(
    await requestJson(
      apiUrl(
        `/works/${encodeURIComponent(workEntryId)}/notes/${encodeURIComponent(noteEntryId)}/review`
      )
    )
  );
}

// Add one saved note to Review: idempotently create-or-reuse its current-note prompt and active card,
// returning the resulting objective status. Safe to call again — a second submit reuses the same prompt
// and card without resetting the schedule. The target is fully addressed by the URL, so the POST carries
// no body (and no JSON content-type, which Fastify would otherwise reject as an empty JSON body).
export async function addNoteToReview(
  workEntryId: string,
  noteEntryId: string
): Promise<NoteReviewEnrollmentStatusDto> {
  return parseNoteReviewEnrollmentStatusDto(
    await requestJson(
      apiUrl(
        `/works/${encodeURIComponent(workEntryId)}/notes/${encodeURIComponent(noteEntryId)}/review/enrollment`
      ),
      { method: "POST" }
    )
  );
}

// One owned note's Review status for the Notes home (#659), owner-scoped so a standalone note reads too.
// A read; it changes nothing.
export async function fetchOwnedNoteReviewStatus(
  noteEntryId: string
): Promise<NoteReviewEnrollmentStatusDto> {
  return parseNoteReviewEnrollmentStatusDto(
    await requestJson(apiUrl(`/notes/${encodeURIComponent(noteEntryId)}/review`))
  );
}

// Add any owned note to Review from the Notes home (#659), owner-scoped. An anchored note reuses its exact
// source server-side (no question sent); a standalone note supplies the learner's question. Idempotent —
// a re-submit reuses the same prompt and card. A standalone enrollment MUST carry a non-blank question, so
// this sends a JSON body only when a question is given; the anchored path posts no body.
export async function addOwnedNoteToReview(
  noteEntryId: string,
  question?: string
): Promise<NoteReviewEnrollmentStatusDto> {
  const path = apiUrl(`/notes/${encodeURIComponent(noteEntryId)}/review/enrollment`);
  const init: RequestInit =
    question === undefined
      ? { method: "POST" }
      : { body: JSON.stringify({ question }), headers: jsonHeaders, method: "POST" };
  return parseNoteReviewEnrollmentStatusDto(await requestJson(path, init));
}

// The full Review-settings list for one owned note (#660): every prompt in creation order with its reveal
// policy and projected card state. A read; it changes nothing.
export async function fetchNotePromptSettings(
  noteEntryId: string
): Promise<NotePromptSettingsListDto> {
  return parseNotePromptSettingsListDto(
    await requestJson(apiUrl(`/notes/${encodeURIComponent(noteEntryId)}/review/settings`))
  );
}

// One page of a prompt's append-only Review history (#660), newest first. The opaque `cursor` (from a
// previous page's `nextCursor`) loads older events; omit it for the first page. A read; it changes nothing.
export async function fetchNotePromptHistory(
  promptId: string,
  cursor?: string
): Promise<ReviewHistoryPageDto> {
  const base = apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/history`);
  const path = cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`;
  return parseReviewHistoryPageDto(await requestJson(path));
}

// Edit one prompt's retrieval question (#660): writes ONLY the cue and returns the refreshed settings row.
export async function editNotePromptQuestion(
  promptId: string,
  question: string
): Promise<NotePromptSettingsDto> {
  return parseNotePromptSettingsDto(
    await requestJson(
      apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/question`),
      { body: JSON.stringify({ question }), headers: jsonHeaders, method: "PATCH" }
    )
  );
}

// Apply a card transition to one prompt through its settings route (#660): pause, resume, restart, or
// re-add (POST) and remove (DELETE). Each returns the prompt's refreshed settings row so the caller updates
// exactly that row. The target is fully addressed by the URL, so no body is sent.
async function mutateNotePromptCard(
  promptId: string,
  action: "pause" | "resume" | "restart" | "card",
  method: "POST" | "DELETE"
): Promise<NotePromptSettingsDto> {
  return parseNotePromptSettingsDto(
    await requestJson(
      apiUrl(`/notes/review/prompts/${encodeURIComponent(promptId)}/${action}`),
      { method }
    )
  );
}

export function pauseNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "pause", "POST");
}

export function resumeNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "resume", "POST");
}

export function restartNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "restart", "POST");
}

export function addNotePromptCardBack(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "card", "POST");
}

export function removeNotePromptCard(promptId: string): Promise<NotePromptSettingsDto> {
  return mutateNotePromptCard(promptId, "card", "DELETE");
}
