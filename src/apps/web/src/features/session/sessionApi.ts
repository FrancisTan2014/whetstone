import type {
  EndSessionRequest,
  SessionPlanDto,
  SessionSummaryDto,
  SubmitTurnRequest,
  TurnResultDto
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

export async function submitTurn(request: SubmitTurnRequest): Promise<TurnResultDto> {
  return postJson<TurnResultDto>("/api/session/turn", request);
}

export async function endSession(request: EndSessionRequest): Promise<SessionSummaryDto> {
  return postJson<SessionSummaryDto>("/api/session/end", request);
}
