import type {
  DueRecitationPassageDto,
  RecitationCueStrengthDto,
  RecitationPassageDto,
  RecitationPassageListDto,
  RecitationReviewRating
} from "@whetstone/contracts";
import {
  parseDueRecitationPassageResponse,
  parseRecitationPassageListDto,
  parseRecordRecitationReviewResponse
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The recitation-passage practice API client (#578): divide a plan's Work into passages, edit the
// boundaries, fetch the next due passage, and record a self-assessment. Every response is parsed through
// the shared contracts at the boundary before the feature trusts it, mirroring the recitation-plans client.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// Divide a plan's Work into passages seeded from its source blocks (idempotent server-side); resolves
// with the plan's passages in reciting order.
export async function seedPassages(planEntryId: string): Promise<RecitationPassageListDto> {
  return parseRecitationPassageListDto(
    await requestJson(
      apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/passages/seed`),
      {
        method: "POST"
      }
    )
  );
}

// A plan's passages in reciting order, with each one's review progress.
export async function listPassages(planEntryId: string): Promise<RecitationPassageListDto> {
  return parseRecitationPassageListDto(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/passages`))
  );
}

// The next due passage across the learner's plans, re-anchored server-side, or null when nothing is due.
export async function fetchDuePassage(): Promise<DueRecitationPassageDto | null> {
  return parseDueRecitationPassageResponse(await requestJson(apiUrl("/recitation/passages/due")))
    .passage;
}

// Split a passage at a text position into two contiguous passages; resolves with the reindexed list.
export async function splitPassage(
  passageEntryId: string,
  atBlockEntryId: string,
  atOffset: number
): Promise<RecitationPassageListDto> {
  return parseRecitationPassageListDto(
    await requestJson(apiUrl(`/recitation/passages/${encodeURIComponent(passageEntryId)}/split`), {
      body: JSON.stringify({ atBlockEntryId, atOffset }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// Merge a passage with the next one in reciting order; resolves with the reindexed list.
export async function mergeNextPassage(passageEntryId: string): Promise<RecitationPassageListDto> {
  return parseRecitationPassageListDto(
    await requestJson(
      apiUrl(`/recitation/passages/${encodeURIComponent(passageEntryId)}/merge-next`),
      { method: "POST" }
    )
  );
}

// Record a self-assessment (the FSRS rating + the cue strength attempted from); resolves with the
// passage's updated schedule.
export async function reviewPassage(
  passageEntryId: string,
  rating: RecitationReviewRating,
  cueStrength: RecitationCueStrengthDto
): Promise<RecitationPassageDto> {
  return parseRecordRecitationReviewResponse(
    await requestJson(apiUrl(`/recitation/passages/${encodeURIComponent(passageEntryId)}/review`), {
      body: JSON.stringify({ cueStrength, rating }),
      headers: jsonHeaders,
      method: "POST"
    })
  ).passage;
}
