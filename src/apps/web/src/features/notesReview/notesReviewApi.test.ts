import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  NotePromptSettingsDto,
  NoteReviewPromptDto,
  NoteRevealDto,
  ReviewHistoryPageDto,
  SetNoteGradingTargetRequest
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import {
  addNotePromptCardBack,
  authorNoteCard,
  AuthorNoteCardError,
  createDirectCard,
  CreateDirectCardError,
  editNotePromptQuestion,
  fetchMaterialMatches,
  fetchNextNotePrompt,
  fetchNotePromptHistory,
  fetchNotePromptSettings,
  fetchNoteReveal,
  keepSeparateMaterial,
  MaterialDecisionError,
  pauseNotePromptCard,
  rateNotePrompt,
  removeNotePromptCard,
  restartNotePromptCard,
  resumeNotePromptCard,
  setNoteGradingTarget,
  SetNoteGradingTargetError,
  reuseExistingMaterial
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

describe("createDirectCard", () => {
  const request = {
    answerDoc: createTextDocument("Paris is the capital of France."),
    questionDoc: createTextDocument("What is the capital of France?"),
    submissionId: "submission-1",
    target: { kind: "current_note" as const }
  };

  it("POSTs the request as JSON and returns the parsed created save result", async () => {
    const body = { result: { noteId: "note-1", promptId: "prompt-1", review }, status: "created" };
    const fetchMock = stubFetch({ body, ok: true });

    await expect(createDirectCard(request)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/direct-cards", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("parses a needs_material_review save result", async () => {
    const body = {
      review: {
        attemptId: "attempt-1",
        candidateFingerprint: "fp-1",
        candidates: [
          { answerExcerpt: "Paris.", cardCount: 1, noteId: "note-9", sourceContext: null }
        ],
        revision: 0
      },
      status: "needs_material_review"
    };
    stubFetch({ body, ok: true });

    await expect(createDirectCard(request)).resolves.toEqual(body);
  });

  it("throws a conflict error on a 409 (same id, changed payload)", async () => {
    stubFetch({ ok: false, status: 409 });

    await expect(createDirectCard(request)).rejects.toMatchObject({
      kind: "conflict",
      name: "CreateDirectCardError"
    });
  });

  it("throws a gone error on a 410 (the submission's note was deleted)", async () => {
    stubFetch({ ok: false, status: 410 });

    await expect(createDirectCard(request)).rejects.toMatchObject({ kind: "gone" });
  });

  it("throws an invalid error on any other 4xx", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(createDirectCard(request)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("throws a network error on a 5xx", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(createDirectCard(request)).rejects.toMatchObject({ kind: "network" });
  });

  it("throws a network error when fetch itself rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await createDirectCard(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(CreateDirectCardError);
    expect((error as CreateDirectCardError).kind).toBe("network");
  });
});

describe("fetchMaterialMatches (#712)", () => {
  const answerDoc = createTextDocument("Paris is the capital of France.");
  const candidates = [
    { answerExcerpt: "Paris.", cardCount: 1, noteId: "note-9", sourceContext: null }
  ];

  it("POSTs only the answer document and returns the parsed candidates", async () => {
    const fetchMock = stubFetch({ body: { candidates }, ok: true });

    await expect(fetchMaterialMatches(answerDoc)).resolves.toEqual(candidates);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/material-matches", {
      body: JSON.stringify({ answerDoc }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("resolves to an empty list on a non-2xx response (advisory only)", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchMaterialMatches(answerDoc)).resolves.toEqual([]);
  });

  it("resolves to an empty list when fetch itself rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    await expect(fetchMaterialMatches(answerDoc)).resolves.toEqual([]);
  });
});

describe("material review decisions (#712)", () => {
  const base = {
    answerDoc: createTextDocument("Paris is the capital of France."),
    attemptId: "attempt-1",
    questionDoc: createTextDocument("Capital of France?"),
    revision: 0,
    submissionId: "submission-1",
    target: { kind: "current_note" as const }
  };
  const useExistingRequest = { ...base, noteEntryId: "note-9" };
  const savedReused = {
    result: { noteId: "note-9", promptId: "prompt-9", review },
    status: "reused" as const
  };
  const savedCreated = {
    result: { noteId: "note-1", promptId: "prompt-1", review },
    status: "created" as const
  };

  it("reuseExistingMaterial POSTs the request and returns the reused result", async () => {
    const fetchMock = stubFetch({ body: savedReused, ok: true });

    await expect(reuseExistingMaterial(useExistingRequest)).resolves.toEqual(savedReused);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/material-review/use-existing", {
      body: JSON.stringify(useExistingRequest),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("keepSeparateMaterial POSTs the request and returns the created result", async () => {
    const fetchMock = stubFetch({ body: savedCreated, ok: true });

    await expect(keepSeparateMaterial(base)).resolves.toEqual(savedCreated);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/material-review/keep-separate", {
      body: JSON.stringify(base),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("maps a 404 to attempt_not_found", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({
      kind: "attempt_not_found",
      name: "MaterialDecisionError"
    });
  });

  it("maps a 410 to expired, or gone when the submission's note vanished", async () => {
    stubFetch({ body: { error: "attempt_expired" }, ok: false, status: 410 });
    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({ kind: "expired" });

    stubFetch({ body: { error: "submission_gone" }, ok: false, status: 410 });
    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({ kind: "gone" });
  });

  it("maps 409 errors to changed_payload, conflict, or superseded", async () => {
    stubFetch({ body: { error: "changed_payload" }, ok: false, status: 409 });
    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({ kind: "changed_payload" });

    stubFetch({ body: { error: "submission_conflict" }, ok: false, status: 409 });
    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({ kind: "conflict" });

    stubFetch({ body: { error: "attempt_superseded" }, ok: false, status: 409 });
    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({ kind: "superseded" });
  });

  it("maps any other 4xx to invalid and a 5xx to network", async () => {
    stubFetch({ body: { error: "invalid_answer" }, ok: false, status: 400 });
    await expect(reuseExistingMaterial(useExistingRequest)).rejects.toMatchObject({
      kind: "invalid"
    });

    stubFetch({ ok: false, status: 503 });
    await expect(reuseExistingMaterial(useExistingRequest)).rejects.toMatchObject({
      kind: "network"
    });
  });

  it("falls back to a null error body when the 409 payload is not JSON", async () => {
    // A malformed error body must not throw while mapping; the null fallback lands on the default 409 kind.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => {
          throw new Error("not json");
        },
        ok: false,
        status: 409
      }))
    );

    await expect(keepSeparateMaterial(base)).rejects.toMatchObject({ kind: "superseded" });
  });

  it("maps a fetch rejection to network", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );

    const error = await keepSeparateMaterial(base).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(MaterialDecisionError);
    expect((error as MaterialDecisionError).kind).toBe("network");
  });
});

describe("authorNoteCard (#687)", () => {
  const request = {
    noteEntryId: "note-7",
    questionDoc: createTextDocument("What guarantee does a WAL give?"),
    submissionId: "submission-1",
    target: { kind: "current_note" as const }
  };

  it("POSTs the request as JSON and returns the parsed result", async () => {
    const result = { noteId: "note-7", promptId: "prompt-1", review };
    const fetchMock = stubFetch({ body: result, ok: true });

    await expect(authorNoteCard(request)).resolves.toEqual(result);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/author-cards", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws conflict on a 409", async () => {
    stubFetch({ body: { error: "submission_conflict" }, ok: false, status: 409 });

    await expect(authorNoteCard(request)).rejects.toMatchObject({ kind: "conflict" });
  });

  it("throws gone on a 410", async () => {
    stubFetch({ ok: false, status: 410 });

    await expect(authorNoteCard(request)).rejects.toMatchObject({ kind: "gone" });
  });

  it("throws not_found on a 404", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(authorNoteCard(request)).rejects.toMatchObject({ kind: "not_found" });
  });

  it("throws invalid on any other 4xx", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(authorNoteCard(request)).rejects.toMatchObject({ kind: "invalid" });
  });

  it("throws network on a 5xx", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(authorNoteCard(request)).rejects.toMatchObject({ kind: "network" });
  });

  it("throws network when fetch itself rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await authorNoteCard(request).catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AuthorNoteCardError);
    expect((error as AuthorNoteCardError).kind).toBe("network");
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

describe("note Review settings client (#660, rich in #687)", () => {
  const settingsDto: NotePromptSettingsDto = {
    cardState: { state: "due" },
    promptId: "prompt-1",
    revision: 0,
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

  it("PATCHes the rich Question document as JSON to the encoded question endpoint", async () => {
    const questionDoc = createTextDocument("Define a WAL");
    const fetchMock = stubFetch({ body: settingsDto, ok: true });

    const request = { expectedRevision: 3, questionDoc };
    await expect(editNotePromptQuestion("prompt 1", request)).resolves.toEqual(settingsDto);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/prompts/prompt%201/question", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("names stale Question writes as conflicts", async () => {
    stubFetch({ body: { error: "prompt_conflict" }, ok: false, status: 409 });

    await expect(
      editNotePromptQuestion("prompt-1", {
        expectedRevision: 2,
        questionDoc: createTextDocument("Define a WAL")
      })
    ).rejects.toMatchObject({ kind: "conflict", name: "EditNotePromptQuestionError" });
  });

  it("maps Question validation, ownership, and network failures", async () => {
    const request = {
      expectedRevision: 2,
      questionDoc: createTextDocument("Define a WAL")
    };

    stubFetch({ body: { error: "invalid_question" }, ok: false, status: 400 });
    await expect(editNotePromptQuestion("prompt-1", request)).rejects.toMatchObject({
      kind: "invalid_question"
    });

    stubFetch({ ok: false, status: 404 });
    await expect(editNotePromptQuestion("prompt-1", request)).rejects.toMatchObject({
      kind: "not_found"
    });

    stubFetch({ body: { error: "mystery" }, ok: false, status: 409 });
    await expect(editNotePromptQuestion("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
    });
  });

  it("maps an unreadable Question error response and a rejected fetch to network", async () => {
    const request = {
      expectedRevision: 2,
      questionDoc: createTextDocument("Define a WAL")
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        json: async () => {
          throw new Error("not json");
        },
        ok: false,
        status: 409
      }))
    );
    await expect(editNotePromptQuestion("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    await expect(editNotePromptQuestion("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
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

describe("setNoteGradingTarget (#686)", () => {
  const settingsDto: NotePromptSettingsDto = {
    cardState: { state: "due" },
    promptId: "prompt-1",
    revision: 0,
    questionDoc: createTextDocument("What is a WAL?"),
    questionText: "What is a WAL?",
    reveal: { kind: "current_note" }
  };
  const request: SetNoteGradingTargetRequest = {
    expectedRevision: 3,
    mode: "keep",
    target: { kind: "current_note" }
  };

  it("POSTs the request as JSON to the encoded grading-target endpoint", async () => {
    const fetchMock = stubFetch({ body: settingsDto, ok: true });

    await expect(setNoteGradingTarget("prompt 1", request)).resolves.toEqual(settingsDto);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/review/prompts/prompt%201/grading-target", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws invalid_success_check on a 400 with that error body", async () => {
    stubFetch({ body: { error: "invalid_success_check" }, ok: false, status: 400 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "invalid_success_check",
      name: "SetNoteGradingTargetError"
    });
  });

  it("throws network on a 400 without the invalid_success_check error", async () => {
    stubFetch({ body: { error: "other" }, ok: false, status: 400 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
    });
  });

  it("throws not_found on a 404", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "not_found"
    });
  });

  it("throws legacy_read_only on a 409 with that error body", async () => {
    stubFetch({ body: { error: "legacy_read_only" }, ok: false, status: 409 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "legacy_read_only"
    });
  });

  it("throws restart_requires_card on a 409 with that error body", async () => {
    stubFetch({ body: { error: "restart_requires_card" }, ok: false, status: 409 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "restart_requires_card"
    });
  });

  it("throws conflict on a stale prompt revision", async () => {
    stubFetch({ body: { error: "prompt_conflict" }, ok: false, status: 409 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "conflict"
    });
  });

  it("throws network on a 409 whose error body is unrecognized", async () => {
    stubFetch({ body: { error: "mystery" }, ok: false, status: 409 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
    });
  });

  it("throws network on a 5xx", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
    });
  });

  it("treats an unparseable error body as a network failure", async () => {
    const rejectingJson = vi.fn(async () => ({
      json: async () => {
        throw new Error("not json");
      },
      ok: false,
      status: 400
    }));
    vi.stubGlobal("fetch", rejectingJson);

    await expect(setNoteGradingTarget("prompt-1", request)).rejects.toMatchObject({
      kind: "network"
    });
  });

  it("throws network when fetch itself rejects", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await setNoteGradingTarget("prompt-1", request).catch(
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(SetNoteGradingTargetError);
    expect((error as SetNoteGradingTargetError).kind).toBe("network");
  });
});
