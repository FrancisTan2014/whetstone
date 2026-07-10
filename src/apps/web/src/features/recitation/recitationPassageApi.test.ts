import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchDuePassage,
  listPassages,
  mergeNextPassage,
  reviewPassage,
  seedPassages,
  splitPassage
} from "./recitationPassageApi";

const passageDto = {
  anchorStatus: "anchored",
  dueAt: "2026-07-01T09:00:00.000Z",
  endBlockEntryId: "block-a",
  endOffset: 20,
  entryId: "passage-1",
  lapses: 0,
  lastReviewedAt: null,
  orderIndex: 0,
  planEntryId: "plan-1",
  reps: 0,
  reviewCount: 0,
  sourceText: "The quick brown fox.",
  startBlockEntryId: "block-a",
  startOffset: 0
} as const;

const dueDto = {
  anchorStatus: "anchored",
  context: "The Recitation",
  defaultCueStrength: "opening",
  passageEntryId: "passage-1",
  planEntryId: "plan-1",
  precedingText: null,
  targetText: "The quick brown fox.",
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

describe("recitationPassageApi", () => {
  it("seeds a plan's passages with a POST, encoding the id", async () => {
    const fetchMock = mockFetchOnce({ passages: [passageDto], planEntryId: "plan-1" }, true, 201);

    const result = await seedPassages("plan/1");

    expect(result.passages).toHaveLength(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/plans/plan%2F1/passages/seed");
    expect(init.method).toBe("POST");
  });

  it("lists a plan's passages", async () => {
    const fetchMock = mockFetchOnce({ passages: [passageDto], planEntryId: "plan-1" });

    const result = await listPassages("plan-1");

    expect(result.passages[0]?.entryId).toBe("passage-1");
    const [path] = fetchMock.mock.calls[0] as [string];
    expect(path).toBe("/api/recitation/plans/plan-1/passages");
  });

  it("fetches the due passage, tolerating a null", async () => {
    mockFetchOnce({ passage: null });

    const result = await fetchDuePassage();

    expect(result).toBeNull();
  });

  it("fetches the due passage when one is due", async () => {
    mockFetchOnce({ passage: dueDto });

    const result = await fetchDuePassage();

    expect(result?.passageEntryId).toBe("passage-1");
  });

  it("splits a passage, POSTing the cut position", async () => {
    const fetchMock = mockFetchOnce({ passages: [passageDto], planEntryId: "plan-1" });

    await splitPassage("passage-1", "block-a", 4);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/passages/passage-1/split");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ atBlockEntryId: "block-a", atOffset: 4 });
  });

  it("merges a passage with the next one", async () => {
    const fetchMock = mockFetchOnce({ passages: [passageDto], planEntryId: "plan-1" });

    await mergeNextPassage("passage-1");

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/passages/passage-1/merge-next");
    expect(init.method).toBe("POST");
  });

  it("records a review, carrying the rating and cue strength", async () => {
    const fetchMock = mockFetchOnce({ passage: { ...passageDto, reps: 1, reviewCount: 1 } });

    const result = await reviewPassage("passage-1", "good", "opening");

    expect(result.reviewCount).toBe(1);
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/recitation/passages/passage-1/review");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ cueStrength: "opening", rating: "good" });
  });

  it("throws when a request is not ok", async () => {
    mockFetchOnce({}, false, 500);

    await expect(listPassages("plan-1")).rejects.toThrow(/failed with status 500/);
  });
});
