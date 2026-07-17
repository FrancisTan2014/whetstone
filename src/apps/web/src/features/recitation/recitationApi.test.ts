import { afterEach, describe, expect, it, vi } from "vitest";

import {
  enrollRecitation,
  fetchRecitationReview,
  listRecitationPlans,
  recordRecitationReview
} from "./recitationApi";

const planDto = {
  createdAt: "2026-07-01T09:00:00.000Z",
  entryId: "plan-1",
  lastSessionAt: null,
  phase: "maintenance",
  sessionCount: 0,
  updatedAt: "2026-07-01T09:00:00.000Z",
  workEntryId: "work-1",
  workTitle: "Aesop’s Fables"
} as const;

const reviewDto = {
  dueAt: "2026-07-01T09:00:00.000Z",
  planEntryId: "plan-1",
  sourceText: "The North Wind and the Sun.",
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

describe("recitationApi", () => {
  it("enrolls a Work, POSTing the workEntryId and parsing the returned plan", async () => {
    const fetchMock = mockFetchOnce(planDto, true, 201);

    const result = await enrollRecitation("work-1");

    expect(result.entryId).toBe("plan-1");
    expect(result.phase).toBe("maintenance");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/enroll");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ workEntryId: "work-1" });
  });

  it("lists the user's plans", async () => {
    mockFetchOnce({ plans: [planDto] });

    const result = await listRecitationPlans();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.workEntryId).toBe("work-1");
  });

  it("fetches the earliest-due review when no Work is given", async () => {
    const fetchMock = mockFetchOnce({ review: reviewDto });

    const result = await fetchRecitationReview();

    expect(result.review?.planEntryId).toBe("plan-1");
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/recitation/review");
  });

  it("fetches a specific Work's review, encoding the work id, and tolerates a null review", async () => {
    const fetchMock = mockFetchOnce({ review: null });

    const result = await fetchRecitationReview("work/1");

    expect(result.review).toBeNull();
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/recitation/review?work=work%2F1");
  });

  it("records a review with a POST, encoding the plan id and carrying the rating", async () => {
    const fetchMock = mockFetchOnce({
      remainingDueCount: 1,
      review: { ...reviewDto, dueAt: "2026-07-05T09:00:00.000Z" }
    });

    const result = await recordRecitationReview("plan/1", "good");

    expect(result.review.dueAt).toBe("2026-07-05T09:00:00.000Z");
    expect(result.remainingDueCount).toBe(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan%2F1/review");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ rating: "good" });
  });

  it("throws when a request is not ok", async () => {
    mockFetchOnce({}, false, 500);

    await expect(listRecitationPlans()).rejects.toThrow(/failed with status 500/);
  });
});
