import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRecitationOverview } from "./reciteOverviewApi";

const overviewWork = {
  isDue: true,
  nextReviewAt: "2026-07-01T09:00:00.000Z",
  paused: false,
  planEntryId: "plan-1",
  state: "review",
  workEntryId: "work-1",
  workTitle: "Aesop’s Fables"
} as const;

function mockFetchOnce(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => body,
    ok,
    status
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reciteOverviewApi", () => {
  it("fetches the recitation overview and parses it through the contract", async () => {
    const fetchMock = mockFetchOnce({ dueCount: 1, works: [overviewWork] });

    const result = await fetchRecitationOverview();

    expect(result.dueCount).toBe(1);
    expect(result.works[0]?.workEntryId).toBe("work-1");
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/recitation/overview");
  });

  it("throws when the request is not ok", async () => {
    mockFetchOnce({}, false, 500);

    await expect(fetchRecitationOverview()).rejects.toThrow(/failed with status 500/);
  });

  it("rejects a payload that violates the contract", async () => {
    mockFetchOnce({ dueCount: -1, works: [] });

    await expect(fetchRecitationOverview()).rejects.toThrow();
  });
});
