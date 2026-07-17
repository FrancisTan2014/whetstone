import {
  parseNoteRevealDto,
  parseNoteReviewNextDto,
  parseNoteReviewRatingResultDto,
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
