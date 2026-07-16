import type { RecitationHubDto } from "@whetstone/contracts";
import { parseRecitationHubResponse } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The recitation routine hub API client (#608): fetch the hub projection and pause/resume the active
// plan. Every response is parsed through the shared contract at the boundary before the feature trusts
// it, mirroring the recitation-passage client. Pause/resume return the refreshed hub so the page updates
// in one round-trip.
async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// The hub for the current learner: `no_plan` when none is adopted, else the active plan projection. A
// `workEntryId` scopes the hub to THAT exact Work's plan (#633 AC7) — `unadopted_work` when the learner
// has not adopted it — so a contextual link never resolves to the most-recent plan.
export async function getRecitationHub(workEntryId?: string): Promise<RecitationHubDto> {
  const path =
    workEntryId === undefined
      ? apiUrl("/recitation/hub")
      : apiUrl(`/recitation/hub?work=${encodeURIComponent(workEntryId)}`);
  return parseRecitationHubResponse(await requestJson(path)).hub;
}

// Pause a plan; resolves with the refreshed hub (the paused plan surfaces no due work or action).
export async function pausePlan(planEntryId: string): Promise<RecitationHubDto> {
  return parseRecitationHubResponse(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/pause`), {
      method: "POST"
    })
  ).hub;
}

// Resume a paused plan; resolves with the refreshed hub (its preserved cards re-enter selection).
export async function resumePlan(planEntryId: string): Promise<RecitationHubDto> {
  return parseRecitationHubResponse(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/resume`), {
      method: "POST"
    })
  ).hub;
}
