// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LatestReadingPositionDto } from "@whetstone/contracts";

import { fetchLatestReadingPosition } from "./todayApi";

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

describe("fetchLatestReadingPosition", () => {
  it("requests the latest endpoint and returns the parsed position", async () => {
    const position: LatestReadingPositionDto = {
      anchorBlockEntryId: null,
      unitEntryId: "unit-1",
      workEntryId: "work-1",
      workTitle: "Fables"
    };
    const fetchMock = stubFetch({ body: { position }, ok: true });

    await expect(fetchLatestReadingPosition()).resolves.toEqual(position);
    expect(fetchMock).toHaveBeenCalledWith("/api/reading-position/latest");
  });

  it("returns undefined when the server reports no saved position", async () => {
    stubFetch({ body: { position: null }, ok: true });

    await expect(fetchLatestReadingPosition()).resolves.toBeUndefined();
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchLatestReadingPosition()).rejects.toThrow("status 500");
  });
});
