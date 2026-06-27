import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchProgressMap } from "./progressApi";

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

describe("fetchProgressMap", () => {
  it("requests the progress-map endpoint and returns its JSON", async () => {
    const body = { domains: [], recommendedCaseId: null };
    const fetchMock = stubFetch({ body, ok: true });

    await expect(fetchProgressMap()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/progress-map");
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchProgressMap()).rejects.toThrow("status 500");
  });
});
