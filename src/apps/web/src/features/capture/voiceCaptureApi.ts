import {
  audioContentType,
  parseVoiceCaptureAcceptedDto,
  parseVoiceCaptureListDto,
  parseVoiceCaptureStatusDto,
  type VoiceCaptureAcceptedDto,
  type VoiceCaptureStatusDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The async Tap-and-Talk client (#566): the recording is saved first, then a background worker
// transcribes → tidies → makes it ready. This is the browser side of that contract — submit the audio,
// then poll each capture's status until it is ready or failed, and rebuild the pending list from the
// server on load/refresh. Every response is parsed through the shared contracts schema so a drifted
// server shape is caught at the boundary rather than surfacing as a render-time crash.

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
  return response.json();
}

// Save a recorded clip: POST the raw audio bytes (octet-stream); the server files a pending diary capture
// and returns its id + `queued` status immediately, so the user can record again without waiting for STT.
// No capture language is sent — the worker auto-detects the language during transcription (#647).
export async function submitVoiceCapture(audio: Blob): Promise<VoiceCaptureAcceptedDto> {
  return parseVoiceCaptureAcceptedDto(
    await requestJson(apiUrl("/diary/voice-captures"), {
      body: audio,
      headers: { "content-type": audioContentType },
      method: "POST"
    })
  );
}

// Rebuild the pending UI on load/refresh: the user's still-in-flight and failed captures, oldest first.
// Ready captures are omitted — they already appear in the Timeline as ordinary entries.
export async function fetchActiveVoiceCaptures(): Promise<ReadonlyArray<VoiceCaptureStatusDto>> {
  const { captures } = parseVoiceCaptureListDto(await requestJson(apiUrl("/diary/voice-captures")));
  return captures;
}

// Poll one capture's processing status (queued/transcribing/tidying/ready/failed).
export async function fetchVoiceCaptureStatus(id: string): Promise<VoiceCaptureStatusDto> {
  return parseVoiceCaptureStatusDto(
    await requestJson(apiUrl(`/diary/voice-captures/${encodeURIComponent(id)}`))
  );
}

// Retry a failed capture: re-queue it from the same saved audio and get back its (re-queued) status.
export async function retryVoiceCapture(id: string): Promise<VoiceCaptureStatusDto> {
  return parseVoiceCaptureStatusDto(
    await requestJson(apiUrl(`/diary/voice-captures/${encodeURIComponent(id)}/retry`), {
      method: "POST"
    })
  );
}
