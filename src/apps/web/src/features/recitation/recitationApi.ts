import type {
  RecitationPlanDto,
  RecitationPlanListDto,
  RecitationReviewRating,
  RecitationReviewResponse,
  RecordRecitationReviewResponse
} from "@whetstone/contracts";
import {
  parseRecitationPlanDto,
  parseRecitationPlanListDto,
  parseRecitationReviewResponse,
  parseRecordRecitationReviewResponse
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The direct-maintenance recitation API client (#643): "I can recite this" enrolls a known Work straight
// into FSRS maintenance, and the review reveals the canonical source and records one whole-Work rating.
// Every response is parsed through the shared contracts at the boundary before the feature trusts it, and
// `apiUrl` supplies the host base so no path hardcodes `/api`.
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

// Enroll a known Work into Recitation maintenance ("I can recite this"); the server returns the plan whose
// durable identity carries the Work through review. Idempotent server-side: re-enrolling reuses the plan.
export async function enrollRecitation(workEntryId: string): Promise<RecitationPlanDto> {
  return requestJson(
    apiUrl("/recitation/enroll"),
    { body: JSON.stringify({ workEntryId }), headers: jsonHeaders, method: "POST" },
    parseRecitationPlanDto
  );
}

// The current user's recitation plans, so the Library can mark which Works are already in maintenance.
export async function listRecitationPlans(): Promise<RecitationPlanListDto> {
  return requestJson(apiUrl("/recitation/plans"), undefined, parseRecitationPlanListDto);
}

// The Work-level maintenance review to open: with `workEntryId` the exact Work's review (the review right
// after enrolling), or with none the earliest-due Work. `review` is null when nothing is due / the Work is
// not enrolled, so the caller routes to a Library recovery path instead of a dead screen.
export async function fetchRecitationReview(
  workEntryId?: string
): Promise<RecitationReviewResponse> {
  const path =
    workEntryId === undefined
      ? apiUrl("/recitation/review")
      : apiUrl(`/recitation/review?work=${encodeURIComponent(workEntryId)}`);
  return requestJson(path, undefined, parseRecitationReviewResponse);
}

// Record one whole-Work maintenance review: rate the plan's single Work-level card; the server appends one
// review event, reschedules only that card, and returns the rescheduled review with its next due instant.
export async function recordRecitationReview(
  planEntryId: string,
  rating: RecitationReviewRating
): Promise<RecordRecitationReviewResponse> {
  return requestJson(
    apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/review`),
    { body: JSON.stringify({ rating }), headers: jsonHeaders, method: "POST" },
    parseRecordRecitationReviewResponse
  );
}
