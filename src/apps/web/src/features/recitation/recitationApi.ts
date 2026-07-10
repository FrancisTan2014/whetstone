import type {
  ContinueRecitationDto,
  CreateRecitationPlanRequest,
  RecitationPhaseDto,
  RecitationPlanDto,
  RecitationPlanListDto
} from "@whetstone/contracts";
import {
  parseContinueRecitationDto,
  parseRecitationPlanDto,
  parseRecitationPlanListDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The recitation-routines API client (#577): every response is parsed through the shared contracts at the
// boundary before the feature trusts it, mirroring the authored-Works/diary clients. `apiUrl` supplies the
// host base, so no path hardcodes `/api`.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson<T>(
  path: string,
  init: RequestInit | undefined,
  parse: (value: unknown) => T
): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return parse(await response.json());
}

// Adopt a source Work as a recitation routine in the chosen initial phase; the server returns the plan.
export async function createRecitationPlan(
  request: CreateRecitationPlanRequest
): Promise<RecitationPlanDto> {
  return requestJson(
    apiUrl("/recitation/plans"),
    { body: JSON.stringify(request), headers: jsonHeaders, method: "POST" },
    parseRecitationPlanDto
  );
}

// The current user's recitation plans, so the Library can mark which Works are already being recited.
export async function listRecitationPlans(): Promise<RecitationPlanListDto> {
  return requestJson(apiUrl("/recitation/plans"), undefined, parseRecitationPlanListDto);
}

// Today's "Continue recitation" target: the most recently touched plan, or null when there is none.
export async function fetchContinueRecitation(): Promise<ContinueRecitationDto> {
  return requestJson(apiUrl("/recitation/continue"), undefined, parseContinueRecitationDto);
}

// The explicit learner-driven phase transition (e.g. "Start reciting"); resolves with the updated plan.
export async function setRecitationPhase(
  planEntryId: string,
  phase: RecitationPhaseDto
): Promise<RecitationPlanDto> {
  return requestJson(
    apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/phase`),
    { body: JSON.stringify({ phase }), headers: jsonHeaders, method: "PUT" },
    parseRecitationPlanDto
  );
}

// Record one lightweight reading session (session count + last-session time); resolves with the plan.
export async function recordRecitationSession(planEntryId: string): Promise<RecitationPlanDto> {
  return requestJson(
    apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/session`),
    { method: "POST" },
    parseRecitationPlanDto
  );
}
