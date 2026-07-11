import { afterEach, describe, expect, it, vi } from "vitest";

import type { MemoryPromptCardDto, MemoryPromptDto, ReviewStateDto } from "@whetstone/contracts";

import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";

const review: ReviewStateDto = {
  due: "2026-01-01T00:00:00.000Z",
  stability: 0,
  difficulty: 0,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  state: "new",
  lastReviewedAt: null
};

function makeCard(overrides: Partial<MemoryPromptCardDto> = {}): MemoryPromptCardDto {
  return {
    answerText: "fast",
    chunkId: null,
    cueText: "quick",
    noteId: "note-1",
    promptId: "prompt-1",
    review,
    ...overrides
  };
}

function makePrompt(overrides: Partial<MemoryPromptDto> = {}): MemoryPromptDto {
  return {
    answerText: "fast",
    chunkId: null,
    cueText: "quick",
    lifecycle: "scheduled",
    noteId: "note-1",
    promptId: "prompt-1",
    review,
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
  it("requests the due endpoint and returns the parsed prompt card list", async () => {
    const card = makeCard();
    const fetchMock = stubFetch({ body: { items: [card] }, ok: true });

    await expect(fetchDueRecall()).resolves.toEqual([card]);
    expect(fetchMock).toHaveBeenCalledWith("/api/recall/due", undefined);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchDueRecall()).rejects.toThrow("status 500");
  });
});

describe("gradeRecall", () => {
  it("posts the rating to the prompt review endpoint and returns the parsed prompt", async () => {
    const prompt = makePrompt();
    const fetchMock = stubFetch({ body: prompt, ok: true });

    await expect(gradeRecall("prompt-1", "good")).resolves.toEqual(prompt);
    expect(fetchMock).toHaveBeenCalledWith("/api/recall/prompts/prompt-1/review", {
      body: JSON.stringify({ rating: "good" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(gradeRecall("prompt-1", "again")).rejects.toThrow("status 404");
  });
});

describe("snoozeRecall", () => {
  it("posts to the prompt snooze endpoint and returns the parsed prompt", async () => {
    const prompt = makePrompt();
    const fetchMock = stubFetch({ body: prompt, ok: true });

    await expect(snoozeRecall("prompt-1")).resolves.toEqual(prompt);
    expect(fetchMock).toHaveBeenCalledWith("/api/recall/prompts/prompt-1/snooze", {
      method: "POST"
    });
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(snoozeRecall("prompt-1")).rejects.toThrow("status 404");
  });
});
