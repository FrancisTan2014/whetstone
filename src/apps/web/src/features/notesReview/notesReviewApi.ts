import {
  parseNoteRevealDto,
  parseNoteReviewEnrollmentStatusDto,
  parseNoteReviewNextDto,
  parseNoteReviewRatingResultDto,
  type NoteReviewEnrollmentStatusDto,
  type NoteReviewPromptDto,
  type NoteRevealDto,
  type NoteReviewRatingResultDto
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
