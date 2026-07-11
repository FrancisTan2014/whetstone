import {
  parseMemoryPromptCardListDto,
  parseMemoryPromptDto,
  type MemoryPromptCardDto,
  type MemoryPromptDto
} from "@whetstone/contracts";
import { type ReviewRating } from "@whetstone/domain";

import { apiUrl } from "../../shared/runtime";

// Recall keeps its own fetch helper so it stays decoupled from the other features. Every response is
// parsed through the shared contracts schema, so a drifted server shape is caught at the boundary rather
// than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// Today's due batch (already capped server-side). The reader stays calm — this is the only recall surface.
export async function fetchDueRecall(): Promise<ReadonlyArray<MemoryPromptCardDto>> {
  return parseMemoryPromptCardListDto(await requestJson(apiUrl("/recall/due"))).items;
}

// Self-grade one prompt: the learner's Again/Hard/Good/Easy rating crosses the wire directly and the
// FSRS scheduler applies it server-side.
export async function gradeRecall(
  promptId: string,
  rating: ReviewRating
): Promise<MemoryPromptDto> {
  return parseMemoryPromptDto(
    await requestJson(apiUrl(`/recall/prompts/${encodeURIComponent(promptId)}/review`), {
      body: JSON.stringify({ rating }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// Snooze one prompt: defer it out of today's batch (no grade, no body).
export async function snoozeRecall(promptId: string): Promise<MemoryPromptDto> {
  return parseMemoryPromptDto(
    await requestJson(apiUrl(`/recall/prompts/${encodeURIComponent(promptId)}/snooze`), {
      method: "POST"
    })
  );
}
