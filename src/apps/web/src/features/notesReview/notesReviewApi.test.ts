import { afterEach, describe, expect, it, vi } from "vitest";

import type { NoteReviewPromptDto, NoteRevealDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { fetchNextNotePrompt, fetchNoteReveal, rateNotePrompt } from "./notesReviewApi";

const review = {
  due: "2026-07-11T12:00:00.000Z",
  stability: 1,
  difficulty: 5,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 1,
  lapses: 0,
  state: "review",
  lastReviewedAt: null
} as const;

function makePrompt(overrides: Partial<NoteReviewPromptDto> = {}): NoteReviewPromptDto {
  return {
    promptId: "prompt-1",
    noteId: "note-1",
    cueDoc: createTextDocument("What is the capital of France?"),
    cueText: "What is the capital of France?",
    revealKind: "legacy_custom",
    review,
    ...overrides
  };
}

const legacyReveal: NoteRevealDto = {
  kind: "legacy_custom",
  answerDoc: createTextDocument("Paris."),
  answerText: "Paris."
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

describe("fetchNextNotePrompt", () => {
  it("requests the next endpoint and returns the parsed prompt", async () => {
    const prompt = makePrompt();
    const fetchMock = stubFetch({ body: { prompt }, ok: true });

    await expect(fetchNextNotePrompt()).resolves.toEqual(prompt);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/next", undefined);
  });

  it("returns null when nothing is due", async () => {
    stubFetch({ body: { prompt: null }, ok: true });

    await expect(fetchNextNotePrompt()).resolves.toBeNull();
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchNextNotePrompt()).rejects.toThrow("status 500");
  });
});

describe("fetchNoteReveal", () => {
  it("requests the reveal endpoint with an encoded prompt id", async () => {
    const fetchMock = stubFetch({ body: legacyReveal, ok: true });

    await expect(fetchNoteReveal("prompt 1")).resolves.toEqual(legacyReveal);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notes/review/prompts/prompt%201/reveal",
      undefined
    );
  });

  it("throws when the prompt cannot be revealed", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchNoteReveal("prompt-1")).rejects.toThrow("status 404");
  });
});

describe("rateNotePrompt", () => {
  it("POSTs the rating as JSON to the encoded rating endpoint", async () => {
    const fetchMock = stubFetch({ body: { review }, ok: true });

    await expect(rateNotePrompt("prompt 1", "good")).resolves.toEqual({ review });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/prompts/prompt%201/rating", {
      body: JSON.stringify({ rating: "good" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the rating request fails", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(rateNotePrompt("prompt-1", "again")).rejects.toThrow("status 400");
  });
});
