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
// the due-first inline step and raw availability booleans recomputed from canonical state, aggregated
// across every unpaused plan (#633). `pinnedPlanEntryId` keeps the routine on the Work the caller is
// working while it still holds required work, so clearing its items never context-switches mid-Work;
// once that Work is clear the aggregate advances to the next Work.
export async function getRecitationSession(
  pinnedPlanEntryId?: string
): Promise<RecitationSessionDto> {
  const path =
    pinnedPlanEntryId === undefined
      ? apiUrl("/recitation/session")
      : `${apiUrl("/recitation/session")}?pinned=${encodeURIComponent(pinnedPlanEntryId)}`;
  return parseRecitationSessionResponse(await requestJson(path)).session;
}
