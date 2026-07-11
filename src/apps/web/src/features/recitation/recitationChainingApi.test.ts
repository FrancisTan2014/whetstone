import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeChain,
  fetchChaining,
  fetchToday,
  reviewWholeWork,
  startChain
} from "./recitationChainingApi";

const chainDto = {
  chainId: "chain-1",
  endOrderIndex: 1,
  passages: [
    { orderIndex: 0, passageEntryId: "passage-0", sourceText: "First line." },
    { orderIndex: 1, passageEntryId: "passage-1", sourceText: "Second line." }
  ],
  planEntryId: "plan-1",
  status: "active"
} as const;

const chainingDto = {
  activeChain: null,
  chainEligibility: { maxEndIndex: 1, status: "eligible" },
  ownedPrefix: { ownedCount: 2, total: 3 },
  planEntryId: "plan-1",
  wholeWork: { due: false, dueAt: null, exists: false },
  wholeWorkOwned: false
} as const;

const wholeWorkDto = {
  due: false,
  dueAt: "2026-07-10T09:00:00.000Z",
  exists: true
} as const;

const todayDto = {
  action: "chain",
  activeChain: chainDto,
  planEntryId: "plan-1",
  workTitle: "The Recitation"
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

describe("recitationChainingApi", () => {
  it("fetches a plan's chaining progress, encoding the id", async () => {
    const fetchMock = mockFetchOnce({ chaining: chainingDto });

    const result = await fetchChaining("plan/1");

    expect(result.ownedPrefix.ownedCount).toBe(2);
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan%2F1/chaining");
  });

  it("starts a chain with a POST carrying the end boundary", async () => {
    const fetchMock = mockFetchOnce({ chain: chainDto }, true, 201);

    const result = await startChain("plan-1", 1);

    expect(result.chainId).toBe("chain-1");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan-1/chain");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ endOrderIndex: 1 });
  });

  it("completes a chain, reporting the reveal outcome", async () => {
    const fetchMock = mockFetchOnce({ chain: { ...chainDto, status: "completed" } });

    const result = await completeChain("chain-1", { passageEntryId: "passage-1", status: "broke" });

    expect(result.status).toBe("completed");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/chains/chain-1/complete");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      outcome: { passageEntryId: "passage-1", status: "broke" }
    });
  });

  it("reviews the whole-work prompt with a rating and outcome", async () => {
    const fetchMock = mockFetchOnce({ wholeWork: wholeWorkDto });

    const result = await reviewWholeWork("plan-1", "good", { status: "held" });

    expect(result.exists).toBe(true);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan-1/whole-work/review");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      outcome: { status: "held" },
      rating: "good"
    });
  });

  it("reads the single bounded Today action", async () => {
    const fetchMock = mockFetchOnce({ today: todayDto });

    const result = await fetchToday();

    expect(result.action).toBe("chain");
    expect(result.activeChain?.chainId).toBe("chain-1");
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/today");
  });

  it("throws when a request fails", async () => {
    mockFetchOnce({}, false, 404);

    await expect(fetchChaining("plan-1")).rejects.toThrow(
      "Request to /api/recitation/plans/plan-1/chaining failed with status 404."
    );
  });
});
