import { afterEach, describe, expect, it, vi } from "vitest";

import { endSession, say, startSession, transcribe } from "./sessionApi";

function stubFetch(response: {
  body?: unknown;
  ok: boolean;
  status?: number;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    json: async () => response.body,
    ok: response.ok,
    status: response.status ?? 200
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sessionApi", () => {
  it("starts a session with no body", async () => {
    const fetchMock = stubFetch({ body: { cues: [] }, ok: true });

    await expect(startSession()).resolves.toEqual({ cues: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/session/start", { method: "POST" });
  });

  it("transcribes a recorded utterance via the STT endpoint", async () => {
    const body = { transcript: "hello", words: [{ end: 300, start: 0, text: "hello" }] };
    const fetchMock = stubFetch({ body, ok: true });
    const audio = new Uint8Array([1, 2, 3]);

    await expect(transcribe(audio)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/session/transcribe", {
      body: audio,
      headers: { "content-type": "application/octet-stream" },
      method: "POST"
    });
  });

  it("throws when transcription fails", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(transcribe(new Uint8Array([1]))).rejects.toThrow("status 500");
  });

  it("asks the coach for its next line over /api/session/say", async () => {
    const fetchMock = stubFetch({ body: { say: "Tell me more." }, ok: true });
    const request = { caseId: "k.table", transcript: "help yourself" } as const;

    await expect(say(request)).resolves.toEqual({ say: "Tell me more." });
    expect(fetchMock).toHaveBeenCalledWith("/api/session/say", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("ends the round and returns the debrief over /api/session/end", async () => {
    const debrief = {
      due: [],
      encouragement: "Good round.",
      moments: [],
      upgrade: { native: "n", said: "s" },
      wins: []
    };
    const fetchMock = stubFetch({ body: debrief, ok: true });
    const request = { caseId: "k.table", words: [] };

    await expect(endSession(request)).resolves.toEqual(debrief);
    expect(fetchMock).toHaveBeenCalledWith("/api/session/end", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(startSession()).rejects.toThrow("status 500");
  });
});
