import { afterEach, describe, expect, it, vi } from "vitest";

import { getRecitationHub, pausePlan, resumePlan } from "./recitationHubApi";

const activeHub = {
  due: { dueCount: 2, overdueCount: 1 },
  introduction: {
    anyIntroduced: true,
    dailyCap: 3,
    dueCount: 2,
    introducedToday: 1,
    newPassageAvailable: false,
    nextQueued: null,
    phase: "learning",
    planEntryId: "plan-1",
    reason: "due_work_remains",
    remainingCapacity: 2
  },
  passages: { introducedCount: 4, totalCount: 12 },
  paused: false,
  phase: "learning",
  planEntryId: "plan-1",
  primaryAction: "due_passage",
  stage: "learn_passage",
  status: "active",
  workTitle: "Meditations"
} as const;

const pausedHub = { ...activeHub, paused: true, primaryAction: "none" } as const;

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

describe("recitationHubApi", () => {
  it("reads the hub projection, parsed through the contract", async () => {
    const fetchMock = mockFetchOnce({ hub: activeHub });

    const result = await getRecitationHub();

    expect(result.status).toBe("active");
    const [path] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/hub");
  });

  it("reads the restrained no-plan projection", async () => {
    mockFetchOnce({ hub: { status: "no_plan" } });

    const result = await getRecitationHub();

    expect(result.status).toBe("no_plan");
  });

  it("pauses a plan with a POST, encoding the id, and returns the refreshed hub", async () => {
    const fetchMock = mockFetchOnce({ hub: pausedHub });

    const result = await pausePlan("plan/1");

    expect(result.status === "active" && result.paused).toBe(true);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan%2F1/pause");
    expect(init.method).toBe("POST");
  });

  it("resumes a plan with a POST and returns the refreshed hub", async () => {
    const fetchMock = mockFetchOnce({ hub: activeHub });

    const result = await resumePlan("plan-1");

    expect(result.status === "active" && result.paused).toBe(false);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan-1/resume");
    expect(init.method).toBe("POST");
  });

  it("throws when a request fails", async () => {
    mockFetchOnce({}, false, 404);

    await expect(getRecitationHub()).rejects.toThrow(
      "Request to /api/recitation/hub failed with status 404."
    );
  });
});
