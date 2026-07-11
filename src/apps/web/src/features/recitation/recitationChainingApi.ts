import type {
  RecitationChainDto,
  RecitationChainingDto,
  RecitationReviewRating,
  RecitationTodayDto,
  SessionRecallOutcomeDto,
  WholeWorkStateDto
} from "@whetstone/contracts";
import {
  parseRecitationChainingResponse,
  parseRecitationChainResponse,
  parseRecitationTodayResponse,
  parseWholeWorkResponse
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The recitation-chaining practice API client (#580): read a plan's chaining progress (owned prefix,
// chain/whole-work eligibility), start and complete a contiguous chain session, review the separate
// whole-work maintenance prompt, and read the single bounded Today action. Every response is parsed
// through the shared contracts at the boundary before the feature trusts it, mirroring the passage client.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// A plan's chaining progress, computed server-side at request time: the owned prefix, whether a chain
// may be offered (and its furthest end boundary), the active chain if any, and whole-work eligibility.
export async function fetchChaining(planEntryId: string): Promise<RecitationChainingDto> {
  return parseRecitationChainingResponse(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/chaining`))
  ).chaining;
}

// Start a contiguous chain session for the plan ending at the chosen 0-based passage index; resolves
// with the persisted chain (passages [0..endOrderIndex] in fixed order).
export async function startChain(
  planEntryId: string,
  endOrderIndex: number
): Promise<RecitationChainDto> {
  return parseRecitationChainResponse(
    await requestJson(apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/chain`), {
      body: JSON.stringify({ endOrderIndex }),
      headers: jsonHeaders,
      method: "POST"
    })
  ).chain;
}

// Complete an active chain session, reporting whether recall held or broke at one identified passage
// (only an identified passage receives an Again); resolves with the completed chain.
export async function completeChain(
  chainId: string,
  outcome: SessionRecallOutcomeDto
): Promise<RecitationChainDto> {
  return parseRecitationChainResponse(
    await requestJson(apiUrl(`/recitation/chains/${encodeURIComponent(chainId)}/complete`), {
      body: JSON.stringify({ outcome }),
      headers: jsonHeaders,
      method: "POST"
    })
  ).chain;
}

// Review the whole-work maintenance prompt: the aggregate FSRS rating plus the reveal outcome (an
// identified broken passage also gets an Again). A lapse reschedules only this aggregate prompt.
export async function reviewWholeWork(
  planEntryId: string,
  rating: RecitationReviewRating,
  outcome: SessionRecallOutcomeDto
): Promise<WholeWorkStateDto> {
  return parseWholeWorkResponse(
    await requestJson(
      apiUrl(`/recitation/plans/${encodeURIComponent(planEntryId)}/whole-work/review`),
      {
        body: JSON.stringify({ outcome, rating }),
        headers: jsonHeaders,
        method: "POST"
      }
    )
  ).wholeWork;
}

// The single recitation action Today surfaces across the learner's plans (due passage > active chain >
// whole-work > none), so Today is never a wall of overdue reviews.
export async function fetchToday(): Promise<RecitationTodayDto> {
  return parseRecitationTodayResponse(await requestJson(apiUrl("/recitation/today"))).today;
}
