import { parseTodayBoardResponse, type TodayBoardDto } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// Today's single fetch (#610): the whole board is composed server-side into one read model for the
// learner's local day, so the client makes exactly one request and validates it once at the boundary.
// The page derives all copy and deep links per routine kind; the DTO carries only data.
export async function fetchTodayBoard(): Promise<TodayBoardDto> {
  const response = await fetch(apiUrl("/today"));

  if (!response.ok) {
    throw new Error(`Today board request failed with status ${response.status}.`);
  }

  return parseTodayBoardResponse(await response.json()).board;
}
