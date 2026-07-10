import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRecitationPlan,
  fetchContinueRecitation,
  listRecitationPlans,
  recordRecitationSession,
  setRecitationPhase
} from "./recitationApi";

const planDto = {
  createdAt: "2026-07-01T09:00:00.000Z",
  entryId: "plan-1",
  lastSessionAt: null,
  phase: "familiarizing",
  sessionCount: 0,
  updatedAt: "2026-07-01T09:00:00.000Z",
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
  it("adopts a Work, POSTing the request and parsing the returned plan", async () => {
    const fetchMock = mockFetchOnce(planDto, true, 201);

    const result = await createRecitationPlan({ phase: "familiarizing", workEntryId: "work-1" });

    expect(result.entryId).toBe("plan-1");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      phase: "familiarizing",
      workEntryId: "work-1"
    });
  });

  it("lists the user's plans", async () => {
    mockFetchOnce({ plans: [planDto] });

    const result = await listRecitationPlans();

    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.workEntryId).toBe("work-1");
  });

  it("fetches the continue-recitation target, tolerating a null plan", async () => {
    mockFetchOnce({ plan: null });

    const result = await fetchContinueRecitation();

    expect(result.plan).toBeNull();
  });

  it("sets a phase with a PUT, encoding the id and carrying the phase", async () => {
    const fetchMock = mockFetchOnce({ ...planDto, phase: "learning" });

    const result = await setRecitationPhase("plan/1", "learning");

    expect(result.phase).toBe("learning");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan%2F1/phase");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ phase: "learning" });
  });

  it("records a session with a POST, encoding the id", async () => {
    const fetchMock = mockFetchOnce({
      ...planDto,
      lastSessionAt: "2026-07-04T09:00:00.000Z",
      sessionCount: 1
    });

    const result = await recordRecitationSession("plan-1");

    expect(result.sessionCount).toBe(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan-1/session");
    expect(init.method).toBe("POST");
  });

  it("throws when a request is not ok", async () => {
    mockFetchOnce({}, false, 500);

    await expect(listRecitationPlans()).rejects.toThrow(/failed with status 500/);
  });
});
