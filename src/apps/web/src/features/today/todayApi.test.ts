// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TodayBoardDto } from "@whetstone/contracts";

import { fetchTodayBoard } from "./todayApi";

const board: TodayBoardDto = {
  clear: false,
  continueReading: { status: "empty" },
  continueWriting: { status: "empty" },
  date: "2026-07-01",
  dueNow: [
    {
      dueCount: 2,
      kind: "recitation",
      nextDueAt: "2026-06-30T22:00:00.000Z",
      overdue: true,
      overdueCount: 2
    }
  ],
  routineFailures: []
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

describe("fetchTodayBoard", () => {
  it("requests the Today endpoint and returns the parsed board", async () => {
    const fetchMock = stubFetch({ body: { board }, ok: true });

    await expect(fetchTodayBoard()).resolves.toEqual(board);
    expect(fetchMock).toHaveBeenCalledWith("/api/today");
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 503 });

    await expect(fetchTodayBoard()).rejects.toThrow("status 503");
  });
});
