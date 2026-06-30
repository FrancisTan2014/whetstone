import {
  parseLatestReadingPositionResponse,
  type LatestReadingPositionDto
} from "@whetstone/contracts";

// Today composes already-built slices; its only new fetch is the cross-work "latest reading position"
// seam that powers the Continue reading card. Recall reuses the recall feature's `fetchDueRecall`. The
// response is validated at the boundary; an explicit server null (no saved position) returns undefined.
export async function fetchLatestReadingPosition(): Promise<LatestReadingPositionDto | undefined> {
  const response = await fetch("/api/reading-position/latest");

  if (!response.ok) {
    throw new Error(`Latest reading-position request failed with status ${response.status}.`);
  }

  const { position } = parseLatestReadingPositionResponse(await response.json());

  return position ?? undefined;
}
