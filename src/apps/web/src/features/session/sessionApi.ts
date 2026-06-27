import {
  audioContentType,
  type EndSessionRequest,
  type SessionPlanDto,
  type SessionSummaryDto,
  type SubmitTurnRequest,
  type TranscribeResultDto,
  type TurnResultDto
} from "@whetstone/contracts";

const jsonHeaders = { "content-type": "application/json" } as const;

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : { body: JSON.stringify(body), headers: jsonHeaders, method: "POST" };
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function startSession(): Promise<SessionPlanDto> {
  return postJson<SessionPlanDto>("/api/session/start");
}

// The STT seam (#207): post recorded audio bytes, get back the transcript. The spoken production path
// calls this before submitting the turn; the typed fallback does not.
export async function transcribe(audio: Uint8Array): Promise<TranscribeResultDto> {
  const response = await fetch("/api/session/transcribe", {
    body: audio as BodyInit,
    headers: { "content-type": audioContentType },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request to /api/session/transcribe failed with status ${response.status}.`);
  }

  return (await response.json()) as TranscribeResultDto;
}

export async function submitTurn(request: SubmitTurnRequest): Promise<TurnResultDto> {
  return postJson<TurnResultDto>("/api/session/turn", request);
}

export async function endSession(request: EndSessionRequest): Promise<SessionSummaryDto> {
  return postJson<SessionSummaryDto>("/api/session/end", request);
}
