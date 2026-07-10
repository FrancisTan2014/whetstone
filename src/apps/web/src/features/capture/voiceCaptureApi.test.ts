import { afterEach, describe, expect, it, vi } from "vitest";

import type { VoiceCaptureStatusDto } from "@whetstone/contracts";

import {
  fetchActiveVoiceCaptures,
  fetchVoiceCaptureStatus,
  retryVoiceCapture,
  submitVoiceCapture
} from "./voiceCaptureApi";

const queued: VoiceCaptureStatusDto = {
  failureReason: null,
  id: "cap-1",
  language: "en",
  occurredAt: "2026-07-09T10:00:00.000Z",
  status: "queued",
  text: null
};

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

describe("submitVoiceCapture", () => {
  it("posts the audio bytes with the language and parses the acceptance", async () => {
    const fetchMock = stubFetch({ body: { id: "cap-1", status: "queued" }, ok: true, status: 202 });
    const audio = new Blob(["clip"]);

    expect(await submitVoiceCapture(audio, "zh")).toEqual({ id: "cap-1", status: "queued" });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/diary/voice-captures?language=zh"),
      expect.objectContaining({ body: audio, method: "POST" })
    );
  });

  it("throws on a non-ok response", async () => {
    stubFetch({ ok: false, status: 400 });
    await expect(submitVoiceCapture(new Blob(["x"]), "en")).rejects.toThrow();
  });
});

describe("fetchActiveVoiceCaptures", () => {
  it("parses the pending capture list", async () => {
    stubFetch({ body: { captures: [queued] }, ok: true });
    expect(await fetchActiveVoiceCaptures()).toEqual([queued]);
  });

  it("throws on a non-ok response", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(fetchActiveVoiceCaptures()).rejects.toThrow();
  });
});

describe("fetchVoiceCaptureStatus", () => {
  it("parses one capture's status", async () => {
    const ready: VoiceCaptureStatusDto = { ...queued, status: "ready", text: "hello" };
    const fetchMock = stubFetch({ body: ready, ok: true });

    expect(await fetchVoiceCaptureStatus("cap-1")).toEqual(ready);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/diary/voice-captures/cap-1"),
      undefined
    );
  });

  it("throws on a non-ok response", async () => {
    stubFetch({ ok: false, status: 404 });
    await expect(fetchVoiceCaptureStatus("cap-1")).rejects.toThrow();
  });
});

describe("retryVoiceCapture", () => {
  it("posts to the retry endpoint and parses the re-queued status", async () => {
    const fetchMock = stubFetch({ body: { ...queued, status: "queued" }, ok: true });

    expect((await retryVoiceCapture("cap-1")).status).toBe("queued");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/diary/voice-captures/cap-1/retry"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on a non-ok response", async () => {
    stubFetch({ ok: false, status: 409 });
    await expect(retryVoiceCapture("cap-1")).rejects.toThrow();
  });
});
