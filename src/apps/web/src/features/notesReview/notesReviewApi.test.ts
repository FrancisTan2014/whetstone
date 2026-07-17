import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NotePromptSettingsDto,
  NoteReviewPromptDto,
  NoteRevealDto,
  ReviewHistoryPageDto
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import { fetchNextNotePrompt, fetchNoteReveal, rateNotePrompt } from "./notesReviewApi";
import {
  addNotePromptCardBack,
  addNoteToReview,
  addOwnedNoteToReview,
  editNotePromptQuestion,
  fetchNotePromptHistory,
  fetchNotePromptSettings,
  fetchNoteReviewStatus,
  fetchOwnedNoteReviewStatus,
  pauseNotePromptCard,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard
} from "./notesReviewApi";

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
    const fetchMock = stubFetch({ body: { review, remainingDue: 3 }, ok: true });

    await expect(rateNotePrompt("prompt 1", "good")).resolves.toEqual({ review, remainingDue: 3 });
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

describe("fetchNoteReviewStatus", () => {
  it("GETs the note's review status from the encoded work/note endpoint", async () => {
    const fetchMock = stubFetch({ body: { status: "not_enrolled" }, ok: true });

    await expect(fetchNoteReviewStatus("work 1", "note 7")).resolves.toEqual({
      status: "not_enrolled"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes/note%207/review", undefined);
  });

  it("parses the scheduled status carrying its next-review date", async () => {
    stubFetch({
      body: { status: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" },
      ok: true
    });

    await expect(fetchNoteReviewStatus("work-1", "note-7")).resolves.toEqual({
      status: "scheduled",
      nextReviewAt: "2026-07-11T00:00:00.000Z"
    });
  });

  it("throws when the status read fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchNoteReviewStatus("work-1", "note-7")).rejects.toThrow("status 404");
  });
});

describe("addNoteToReview", () => {
  it("POSTs to the encoded enrollment endpoint and returns the resulting status", async () => {
    const fetchMock = stubFetch({ body: { status: "due" }, ok: true });

    await expect(addNoteToReview("work 1", "note 7")).resolves.toEqual({ status: "due" });
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes/note%207/review/enrollment", {
      method: "POST"
    });
  });

  it("throws when the enrollment request fails", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(addNoteToReview("work-1", "note-7")).rejects.toThrow("status 409");
  });
});

describe("fetchOwnedNoteReviewStatus (#659)", () => {
  it("GETs the owner-scoped note review status", async () => {
    const fetchMock = stubFetch({ body: { status: "not_enrolled" }, ok: true });

    await expect(fetchOwnedNoteReviewStatus("note 7")).resolves.toEqual({
      status: "not_enrolled"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/note%207/review", undefined);
  });

  it("throws when the owner-scoped status read fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchOwnedNoteReviewStatus("note-7")).rejects.toThrow("status 404");
  });
});

describe("addOwnedNoteToReview (#659)", () => {
  it("POSTs an anchored enrollment with no body so the server reuses the exact source", async () => {
    const fetchMock = stubFetch({ body: { status: "due" }, ok: true });

    await expect(addOwnedNoteToReview("note 7")).resolves.toEqual({ status: "due" });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/note%207/review/enrollment", {
      method: "POST"
    });
  });

  it("POSTs a standalone enrollment carrying the learner's question", async () => {
    const fetchMock = stubFetch({
      body: { status: "scheduled", nextReviewAt: "2026-07-11T00:00:00.000Z" },
      ok: true
    });

    await expect(addOwnedNoteToReview("note 7", "What is a WAL?")).resolves.toEqual({
      status: "scheduled",
      nextReviewAt: "2026-07-11T00:00:00.000Z"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/note%207/review/enrollment", {
      body: JSON.stringify({ question: "What is a WAL?" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the owner-scoped enrollment fails", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(addOwnedNoteToReview("note-7")).rejects.toThrow("status 409");
  });
});

describe("note Review settings client (#660)", () => {
  const settingsDto: NotePromptSettingsDto = {
    cardState: { state: "due" },
    promptId: "prompt-1",
    questionDoc: createTextDocument("What is a WAL?"),
    questionText: "What is a WAL?",
    reveal: { kind: "current_note" }
  };

  it("GETs the owner-scoped settings list from the encoded note endpoint", async () => {
    const fetchMock = stubFetch({ body: { prompts: [settingsDto] }, ok: true });

    await expect(fetchNotePromptSettings("note 7")).resolves.toEqual({ prompts: [settingsDto] });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/note%207/review/settings", undefined);
  });

  it("GETs the first history page without a cursor", async () => {
    const page: ReviewHistoryPageDto = {
      events: [{ id: "e1", kind: "reset", occurredAt: "2026-07-01T09:30:00.000Z" }],
      nextCursor: null
    };
    const fetchMock = stubFetch({ body: page, ok: true });

    await expect(fetchNotePromptHistory("prompt 1")).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notes/review/prompts/prompt%201/history",
      undefined
    );
  });

  it("GETs an older history page with the encoded cursor query", async () => {
    const page: ReviewHistoryPageDto = { events: [], nextCursor: null };
    const fetchMock = stubFetch({ body: page, ok: true });

    await expect(fetchNotePromptHistory("prompt-1", "a b|1")).resolves.toEqual(page);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/notes/review/prompts/prompt-1/history?cursor=a%20b%7C1",
      undefined
    );
  });

  it("PATCHes the edited question as JSON to the encoded question endpoint", async () => {
    const fetchMock = stubFetch({ body: settingsDto, ok: true });

    await expect(editNotePromptQuestion("prompt 1", "Define a WAL")).resolves.toEqual(settingsDto);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/prompts/prompt%201/question", {
      body: JSON.stringify({ question: "Define a WAL" }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("POSTs each active card transition with no body", async () => {
    for (const [call, action] of [
      [() => pauseNotePromptCard("p"), "pause"],
      [() => resumeNotePromptCard("p"), "resume"],
      [() => restartNotePromptCard("p"), "restart"],
      [() => addNotePromptCardBack("p"), "card"]
    ] as const) {
      const fetchMock = stubFetch({ body: settingsDto, ok: true });
      await expect(call()).resolves.toEqual(settingsDto);
      expect(fetchMock).toHaveBeenCalledWith(`/api/notes/review/prompts/p/${action}`, {
        method: "POST"
      });
    }
  });

  it("DELETEs the card to remove a prompt from review", async () => {
    const fetchMock = stubFetch({ body: settingsDto, ok: true });

    await expect(removeNotePromptCard("prompt 1")).resolves.toEqual(settingsDto);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/prompts/prompt%201/card", {
      method: "DELETE"
    });
  });

  it("throws when a settings request fails", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(pauseNotePromptCard("prompt-1")).rejects.toThrow("status 409");
  });
});
