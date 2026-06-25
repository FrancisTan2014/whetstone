import {
  parseReadingPositionResponse,
  type UpsertReadingPositionRequest
} from "@whetstone/contracts";

import type { ReadingPosition } from "./readingPosition";

const jsonHeaders = { "content-type": "application/json" } as const;

function positionPath(workEntryId: string): string {
  return `/api/works/${encodeURIComponent(workEntryId)}/reading-position`;
}

// The server is the source of truth for reading position, so the reader keeps its own fetch helper
// (decoupled from the notes/reader/library helpers). The response is validated at the boundary
// before the reader resumes to it; an absent saved position (server `null`) returns undefined.
export async function fetchReadingPosition(
  workEntryId: string
): Promise<ReadingPosition | undefined> {
  const response = await fetch(positionPath(workEntryId));

  if (!response.ok) {
    throw new Error(`Reading-position request failed with status ${response.status}.`);
  }

  const { position } = parseReadingPositionResponse(await response.json());

  if (position === null) {
    return undefined;
  }

  const { anchorBlockEntryId, unitEntryId } = position;

  return anchorBlockEntryId === null || anchorBlockEntryId === undefined
    ? { unitEntryId }
    : { anchorBlockEntryId, unitEntryId };
}

export async function saveReadingPosition(
  workEntryId: string,
  position: ReadingPosition
): Promise<void> {
  const request: UpsertReadingPositionRequest = {
    unitEntryId: position.unitEntryId,
    ...(position.anchorBlockEntryId === undefined
      ? {}
      : { anchorBlockEntryId: position.anchorBlockEntryId })
  };
  const response = await fetch(positionPath(workEntryId), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "PUT"
  });

  if (!response.ok) {
    throw new Error(`Reading-position request failed with status ${response.status}.`);
  }
}
