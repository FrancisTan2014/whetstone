import {
  parseRecallItemDto,
  parseRecallItemListDto,
  type RecallItemDto
} from "@whetstone/contracts";
import { gradeFromRating, type ReviewRating } from "@whetstone/domain";

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
export async function fetchDueRecall(): Promise<ReadonlyArray<RecallItemDto>> {
  return parseRecallItemListDto(await requestJson("/api/recall/due")).items;
}

// Self-grade one item: the four-button rating is mapped to an SM-2 grade before it crosses the wire.
export async function gradeRecall(id: string, rating: ReviewRating): Promise<RecallItemDto> {
  return parseRecallItemDto(
    await requestJson(`/api/recall/items/${encodeURIComponent(id)}/review`, {
      body: JSON.stringify({ grade: gradeFromRating(rating) }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// Snooze one item: defer it out of today's batch (no grade, no body).
export async function snoozeRecall(id: string): Promise<RecallItemDto> {
  return parseRecallItemDto(
    await requestJson(`/api/recall/items/${encodeURIComponent(id)}/snooze`, { method: "POST" })
  );
}
