import {
  parseMakeDurableCardListDto,
  parseQuickCaptureResultDto,
  parseRecallItemDto,
  type CaptureInputMode,
  type MakeDurableCardDto,
  type ProposalPayload,
  type ProposalReviewOutcome,
  type QuickCaptureResultDto,
  type RecallItemDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// Make Durable keeps its own fetch helper so the Today board stays decoupled from the other features.
// Every response is parsed through the shared contracts, so a drifted server shape is caught at the
// boundary rather than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// Submit a Quick Capture: the Timeline entry is saved server-side and an optional review card is
// returned when a proposal passed the gate. `inputMode` marks a typed vs voice capture (a voice
// capture submits its transcript as the text); both follow the same server path.
export async function submitQuickCapture(
  text: string,
  inputMode: CaptureInputMode
): Promise<QuickCaptureResultDto> {
  return parseQuickCaptureResultDto(
    await requestJson(apiUrl("/makedurable/capture"), {
      body: JSON.stringify({ text, inputMode }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// The pending Make Durable review cards for Today (capped server-side).
export async function fetchMakeDurableCards(): Promise<ReadonlyArray<MakeDurableCardDto>> {
  return parseMakeDurableCardListDto(await requestJson(apiUrl("/makedurable/cards"))).cards;
}

export type ReviewCardInput = Readonly<{
  editedPayload?: ProposalPayload;
  outcome: ProposalReviewOutcome;
}>;

// Act on a review card. Save / Edit + Save returns the created recall item; the negative outcomes
// return null (no recall item created).
export async function reviewMakeDurableCard(
  proposalCandidateId: string,
  input: ReviewCardInput
): Promise<RecallItemDto | null> {
  const body = (await requestJson(
    apiUrl(`/makedurable/proposals/${encodeURIComponent(proposalCandidateId)}/review`),
    { body: JSON.stringify(input), headers: jsonHeaders, method: "POST" }
  )) as { recallItem: unknown };

  return body.recallItem === null ? null : parseRecallItemDto(body.recallItem);
}
