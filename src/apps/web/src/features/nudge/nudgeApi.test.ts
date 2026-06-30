import { afterEach, describe, expect, it, vi } from "vitest";

import type { NudgeDto } from "@whetstone/contracts";

import { dismissNudge, fetchNudge } from "./nudgeApi";

function makeNudge(overrides: Partial<NudgeDto> = {}): NudgeDto {
  return {
    blockEntryId: "blk-1",
    caseId: "harvest-note-1",
    chunkId: "harvest-chunk-note-1",
    text: "thrive under pressure",
    workTitle: "On Grit",
    ...overrides
  };
}

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

describe("fetchNudge", () => {
  it("requests the nudge endpoint and returns the parsed nudge", async () => {
    const nudge = makeNudge();
    const fetchMock = stubFetch({ body: { nudge }, ok: true });

    await expect(fetchNudge()).resolves.toEqual(nudge);
    expect(fetchMock).toHaveBeenCalledWith("/api/nudge", undefined);
  });

  it("maps an explicit null to undefined (nothing to surface)", async () => {
    stubFetch({ body: { nudge: null }, ok: true });

    await expect(fetchNudge()).resolves.toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchNudge()).rejects.toThrow("status 500");
  });
});

describe("dismissNudge", () => {
  it("posts to the dismiss endpoint for the given chunk", async () => {
    const fetchMock = stubFetch({ ok: true, status: 204 });

    await expect(dismissNudge("harvest-chunk-note-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/nudge/harvest-chunk-note-1/dismiss", {
      method: "POST"
    });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(dismissNudge("harvest-chunk-note-1")).rejects.toThrow("status 500");
  });
});
