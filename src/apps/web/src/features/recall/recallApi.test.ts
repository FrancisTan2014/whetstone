import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecallItemDto } from "@whetstone/contracts";

import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";

function makeItem(overrides: Partial<RecallItemDto> = {}): RecallItemDto {
  return {
    chunkId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    gloss: null,
    id: "r1",
    kind: "word",
    provenanceEntryId: null,
    review: {
      dueAt: "2026-01-01T00:00:00.000Z",
      easeFactor: 2.5,
      intervalDays: 0,
      lapses: 0,
      lastReviewedAt: null,
      repetitions: 0
    },
    text: "quick",
    ...overrides
  };
}

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

describe("fetchDueRecall", () => {
  it("requests the due endpoint and returns the parsed item list", async () => {
    const item = makeItem();
    const fetchMock = stubFetch({ body: { items: [item] }, ok: true });

    await expect(fetchDueRecall()).resolves.toEqual([item]);
    expect(fetchMock).toHaveBeenCalledWith("/api/recall/due", undefined);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchDueRecall()).rejects.toThrow("status 500");
  });
});

describe("gradeRecall", () => {
  it("maps the rating to an SM-2 grade, posts it, and returns the parsed item", async () => {
    const item = makeItem();
    const fetchMock = stubFetch({ body: item, ok: true });

    await expect(gradeRecall("r1", "good")).resolves.toEqual(item);
    expect(fetchMock).toHaveBeenCalledWith("/api/recall/items/r1/review", {
      body: JSON.stringify({ grade: 4 }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(gradeRecall("r1", "again")).rejects.toThrow("status 404");
  });
});

describe("snoozeRecall", () => {
  it("posts to the snooze endpoint and returns the parsed item", async () => {
    const item = makeItem();
    const fetchMock = stubFetch({ body: item, ok: true });

    await expect(snoozeRecall("r1")).resolves.toEqual(item);
    expect(fetchMock).toHaveBeenCalledWith("/api/recall/items/r1/snooze", { method: "POST" });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(snoozeRecall("r1")).rejects.toThrow("status 404");
  });
});
