import { parseNudgeResponse, type NudgeDto } from "@whetstone/contracts";

// The nudge keeps its own fetch helper so the Today board stays decoupled from the other features.
// The GET response is parsed through the shared contract, so a drifted server shape is caught at the
// boundary rather than surfacing as a render-time crash.
async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// The single proposed reading→practice nudge, or undefined when there is nothing to surface (cold
// start, or everything is in cooldown) — the server's explicit null becomes a plain absence here.
export async function fetchNudge(): Promise<NudgeDto | undefined> {
  return parseNudgeResponse(await requestJson("/api/nudge")).nudge ?? undefined;
}

// Dismiss = cooldown (a "not now"): suppress this capture's nudge for a few days. No body, no result.
export async function dismissNudge(chunkId: string): Promise<void> {
  const response = await fetch(`/api/nudge/${encodeURIComponent(chunkId)}/dismiss`, {
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request to dismiss the nudge failed with status ${response.status}.`);
  }
}
