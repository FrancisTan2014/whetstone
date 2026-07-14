import type { RecitationSessionDto } from "@whetstone/contracts";
import { parseRecitationSessionResponse } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

async function requestJson(path: string): Promise<unknown> {
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// The current learner's transient recitation session projection: `no_plan` when none is adopted, else
// the due-first inline step and raw availability booleans recomputed from canonical state.
export async function getRecitationSession(): Promise<RecitationSessionDto> {
  return parseRecitationSessionResponse(await requestJson(apiUrl("/recitation/session"))).session;
}
