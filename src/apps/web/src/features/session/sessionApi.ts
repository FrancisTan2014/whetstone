import {
  audioContentType,
  type CoachConverseResult,
  type CoachSayRequest,
  type SessionPlanDto,
  type TranscribeResultDto
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

// The STT seam (#207): post a recorded utterance's bytes, get back the transcript. The live call loop
// (#221) calls this on each utterance-end before asking the coach; browser SpeechRecognition is not used.
export async function transcribe(audio: Blob | Uint8Array): Promise<TranscribeResultDto> {
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

// The conversational coach turn (#220): send the learner's latest transcript for the case; get the
// coach's next spoken line (+ light repair only on a breakdown). No per-turn grade — grading is the
// end-of-round job (#222).
export async function say(request: CoachSayRequest): Promise<CoachConverseResult> {
  return postJson<CoachConverseResult>("/api/session/say", request);
}
