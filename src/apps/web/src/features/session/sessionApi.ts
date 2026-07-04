import {
  audioContentType,
  type CoachConverseResult,
  type CoachSayRequest,
  type DebriefDto,
  type EndSessionRequest,
  type SessionPlanDto,
  type TranscribeResultDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

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
  return postJson<SessionPlanDto>(apiUrl("/session/start"));
}

// The STT seam (#207): post a recorded utterance's bytes, get back the transcript. The live call loop
// (#221) calls this on each utterance-end before asking the coach; browser SpeechRecognition is not used.
export async function transcribe(audio: Blob | Uint8Array): Promise<TranscribeResultDto> {
  const path = apiUrl("/session/transcribe");
  const response = await fetch(path, {
    body: audio as BodyInit,
    headers: { "content-type": audioContentType },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as TranscribeResultDto;
}

// The conversational coach turn (#220): send the learner's latest transcript for the case; get the
// coach's next spoken line (+ light repair only on a breakdown). No per-turn grade — grading is the
// end-of-round job (#222).
export async function say(request: CoachSayRequest): Promise<CoachConverseResult> {
  return postJson<CoachConverseResult>(apiUrl("/session/say"), request);
}

// End the round (#222): the server runs the one analysis pass, deposits the durable trace, and returns
// the compact debrief shown after the call.
export async function endSession(request: EndSessionRequest): Promise<DebriefDto> {
  return postJson<DebriefDto>(apiUrl("/session/end"), request);
}
