import { afterEach, describe, expect, it, vi } from "vitest";

import { endSession, startSession, submitTurn } from "./sessionApi";

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

  it("submits a turn with its request body", async () => {
    const fetchMock = stubFetch({ body: { grade: 5 }, ok: true });
    const request = { chunkId: "c1", production: { kind: "typed", transcript: "x" } } as const;

    await submitTurn(request);
    expect(fetchMock).toHaveBeenCalledWith("/api/session/turn", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("ends a session and returns the summary", async () => {
    stubFetch({ body: { turnCount: 1 }, ok: true });
    await expect(endSession({ turns: [] })).resolves.toEqual({ turnCount: 1 });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(startSession()).rejects.toThrow("status 500");
  });
});
