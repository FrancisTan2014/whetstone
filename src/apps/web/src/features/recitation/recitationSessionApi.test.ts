import { afterEach, describe, expect, it, vi } from "vitest";

import { getRecitationSession } from "./recitationSessionApi";

const activeSession = {
  chainAvailable: false,
  due: { dueCount: 1, nextDueAt: "2026-01-01T00:00:00.000Z", overdueCount: 0 },
  hasDuePassage: true,
  newPassage: {
    anyIntroduced: true,
    available: false,
    dailyCap: 3,
    introducedToday: 1,
    remainingCapacity: 2
  },
  paused: false,
  planEntryId: "plan-1",
  status: "active",
  step: "due_passage",
  wholeWorkDue: false,
  workTitle: "Meditations"
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

describe("recitationSessionApi", () => {
  it("reads the session projection, parsed through the contract", async () => {
    const fetchMock = mockFetchOnce({ session: activeSession });

    const result = await getRecitationSession();

    expect(result.status).toBe("active");
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/recitation/session");
  });

  it("throws when the session request fails", async () => {
    mockFetchOnce({}, false, 503);

    await expect(getRecitationSession()).rejects.toThrow(
      "Request to /api/recitation/session failed with status 503."
    );
  });
});
