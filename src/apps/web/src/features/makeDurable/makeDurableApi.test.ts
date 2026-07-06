import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MakeDurableCardDto,
  QuickCaptureResultDto,
  RecallItemDto
} from "@whetstone/contracts";

import { fetchMakeDurableCards, reviewMakeDurableCard, submitQuickCapture } from "./makeDurableApi";

const card: MakeDurableCardDto = {
  proposalCandidateId: "cand-1",
  timelineEntryId: "entry-1",
  type: "phrase_chunk",
  target: "WorkInsight is back up now",
  cue: "a service is back",
  useContext: "reporting availability",
  reason: "a reusable status phrase",
  category: "work",
  tags: ["service-status"]
};

const recallItem: RecallItemDto = {
  chunkId: null,
  createdAt: "2026-07-06T10:00:00.000Z",
  gloss: null,
  id: "recall-1",
  kind: "phrase",
  provenanceEntryId: "entry-1",
  review: {
    dueAt: "2026-07-06T10:00:00.000Z",
    easeFactor: 2.5,
    intervalDays: 0,
    lapses: 0,
    lastReviewedAt: null,
    repetitions: 0
  },
  text: "WorkInsight is back up now",
  cue: "a service is back",
  useContext: "reporting availability",
  category: "work",
  tags: ["service-status"],
  sourceProposalCandidateId: "cand-1"
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

describe("submitQuickCapture", () => {
  it("posts the text and parses the capture result", async () => {
    const result: QuickCaptureResultDto = {
      card,
      timelineEntry: {
        entryId: "entry-1",
        createdAt: "2026-07-06T09:30:00.000Z",
        entryDate: "2026-07-06",
        inputMode: "typed",
        captureSource: "quick_capture",
        rawInputText: "the deploy failed",
        tidiedText: null,
        language: null,
        rawAudioPath: null
      }
    };
    const fetchMock = stubFetch({ body: result, ok: true });

    expect(await submitQuickCapture("the deploy failed")).toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/makedurable/capture"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws on a non-ok response", async () => {
    stubFetch({ ok: false, status: 500 });
    await expect(submitQuickCapture("x")).rejects.toThrow();
  });
});

describe("fetchMakeDurableCards", () => {
  it("parses the pending card list", async () => {
    stubFetch({ body: { cards: [card] }, ok: true });
    expect(await fetchMakeDurableCards()).toEqual([card]);
  });
});

describe("reviewMakeDurableCard", () => {
  it("returns the created recall item on save", async () => {
    stubFetch({ body: { recallItem }, ok: true });
    expect(await reviewMakeDurableCard("cand-1", { outcome: "saved" })).toEqual(recallItem);
  });

  it("returns null when no recall item was created", async () => {
    stubFetch({ body: { recallItem: null }, ok: true });
    expect(await reviewMakeDurableCard("cand-1", { outcome: "wrong_hallucinated" })).toBeNull();
  });

  it("throws on a non-ok response", async () => {
    stubFetch({ ok: false, status: 404 });
    await expect(reviewMakeDurableCard("cand-1", { outcome: "saved" })).rejects.toThrow();
  });
});
