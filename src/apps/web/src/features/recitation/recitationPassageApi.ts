import type {
  ActivateNextRecitationPassageResponse,
  DueRecitationPassageDto,
  RecitationCueStrengthDto,
  RecitationIntroductionStatusDto,
  RecitationPassageDto,
  RecitationPassageListDto,
  RecitationReviewRating,
  RecitationSupportLevelDto
} from "@whetstone/contracts";
import {
  parseActivateNextRecitationPassageResponse,
  parseDueRecitationPassageResponse,
  parseRecitationIntroductionStatusDto,
  parseRecitationPassageListDto,
  parseRecordRecitationReviewResponse,
  parseSetRecitationSupportLevelResponse
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

// The paced new-passage introduction status for a plan (#607): due count, how many passages were
// introduced on the learner's local day out of the cap, the next queued passage preview, and whether
// "New passage" (or "Start first passage") is currently available.
export async function getIntroductionStatus(
  planEntryId: string
): Promise<RecitationIntroductionStatusDto> {
  return parseRecitationIntroductionStatusDto(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/introduction`))
  );
}

// Introduce the next queued passage of a Learning plan (#607); resolves with the newly-activated passage
// and the fresh introduction status so the caller updates the action and pacing state in one round-trip.
export async function introduceNextPassage(
  planEntryId: string
): Promise<ActivateNextRecitationPassageResponse> {
  return parseActivateNextRecitationPassageResponse(
    await requestJson(
      apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/introduce-next`),
      { method: "POST" }
    )
  );
}

// The next due passage across the learner's plans, re-anchored server-side, or null when nothing is due.
export async function fetchDuePassage(): Promise<DueRecitationPassageDto | null> {
  return parseDueRecitationPassageResponse(await requestJson(apiUrl("/recitation/passages/due")))
    .passage;
}

// The next due passage of ONE plan (#608), re-anchored server-side, or null when that plan is caught up.
// The recitation hub uses this so its due-first session reviews the passage of the SAME plan it projects,
// never the earliest-due passage of a different plan.
export async function fetchDuePassageForPlan(
  planEntryId: string
): Promise<DueRecitationPassageDto | null> {
  return parseDueRecitationPassageResponse(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/passages/due`))
  ).passage;
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

// Remember a passage's visual support level (#579): the render-time fading preference, persisted so the
// next attempt opens where the learner left off. This is a preference, not a recall — it never touches
// the FSRS schedule. Resolves with the stored level echoed back.
export async function setSupportLevel(
  passageEntryId: string,
  supportLevel: RecitationSupportLevelDto
): Promise<RecitationSupportLevelDto> {
  return parseSetRecitationSupportLevelResponse(
    await requestJson(
      apiUrl(`/recitation/passages/${encodeURIComponent(passageEntryId)}/support-level`),
      {
        body: JSON.stringify({ supportLevel }),
        headers: jsonHeaders,
        method: "PUT"
      }
    )
  ).supportLevel;
}

// Record a self-assessment (the FSRS rating + the cue strength attempted from); resolves with the
// passage's updated schedule. When the optional predecessor lead-in (#580) broke down, pass
// `leadInFailed` so the immediately preceding passage also receives an Again — otherwise only the due
// target is rated and the lead-in stays ungraded.
export async function reviewPassage(
  passageEntryId: string,
  rating: RecitationReviewRating,
  cueStrength: RecitationCueStrengthDto,
  leadInFailed = false
): Promise<RecitationPassageDto> {
  return parseRecordRecitationReviewResponse(
    await requestJson(apiUrl(`/recitation/passages/${encodeURIComponent(passageEntryId)}/review`), {
      body: JSON.stringify({ cueStrength, leadInFailed, rating }),
      headers: jsonHeaders,
      method: "POST"
    })
  ).passage;
}
