import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  MemoryDepositDto,
  MemoryGlossSuggestionDto,
  MemoryNoteDetailDto,
  MemoryNoteDto,
  MemoryNoteSummaryDto,
  MemoryPromptDto
} from "@whetstone/contracts";

import {
  addPromptToNote,
  createMemory,
  deleteMemoryNote,
  editMemoryNote,
  editMemoryPrompt,
  getMemoryNote,
  importMemory,
  listMemoryNotes,
  suggestGloss
} from "./memoryApi";

function makeSummary(overrides: Partial<MemoryNoteSummaryDto> = {}): MemoryNoteSummaryDto {
  return {
    bodyText: "spill the beans",
    captureSource: "manual",
    draftCount: 0,
    dueCount: 0,
    nextDueAt: null,
    noteId: "note-1",
    promptCount: 1,
    scheduledCount: 1,
    ...overrides
  };
}

function makeNote(overrides: Partial<MemoryNoteDto> = {}): MemoryNoteDto {
  return {
    bodyText: "spill the beans",
    captureSource: "manual",
    derivedFromEntryId: null,
    noteId: "note-1",
    ...overrides
  };
}

function makePrompt(overrides: Partial<MemoryPromptDto> = {}): MemoryPromptDto {
  return {
    answerText: null,
    cardStatus: null,
    chunkId: null,
    cueText: "spill the beans",
    lifecycle: "draft",
    noteId: "note-1",
    promptId: "prompt-1",
    review: null,
    ...overrides
  };
}

function makeDetail(): MemoryNoteDetailDto {
  return { note: makeNote(), prompts: [makePrompt()] };
}

function makeDeposit(): MemoryDepositDto {
  return { note: makeNote(), prompts: [makePrompt()] };
}

function makeSuggestion(
  overrides: Partial<MemoryGlossSuggestionDto> = {}
): MemoryGlossSuggestionDto {
  return { suggestion: "to reveal a secret", term: "spill the beans", ...overrides };
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

describe("listMemoryNotes", () => {
  it("requests the full list when the query is omitted", async () => {
    const summary = makeSummary();
    const fetchMock = stubFetch({ body: { items: [summary] }, ok: true });

    await expect(listMemoryNotes()).resolves.toEqual([summary]);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes", undefined);
  });

  it("requests the full list when the query is blank", async () => {
    const fetchMock = stubFetch({ body: { items: [] }, ok: true });

    await expect(listMemoryNotes("   ")).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes", undefined);
  });

  it("passes a trimmed, encoded term as ?q when the query is non-blank", async () => {
    const summary = makeSummary({ bodyText: "make a decision" });
    const fetchMock = stubFetch({ body: { items: [summary] }, ok: true });

    await expect(listMemoryNotes("  make a  ")).resolves.toEqual([summary]);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes?q=make%20a", undefined);
  });

  it("throws on a non-2xx response", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(listMemoryNotes()).rejects.toThrow("status 500");
  });
});

describe("getMemoryNote", () => {
  it("requests the note detail endpoint with an encoded id", async () => {
    const detail = makeDetail();
    const fetchMock = stubFetch({ body: detail, ok: true });

    await expect(getMemoryNote("note 1")).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes/note%201", undefined);
  });

  it("throws when the note is missing", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(getMemoryNote("note-1")).rejects.toThrow("status 404");
  });
});

describe("createMemory", () => {
  it("posts the deposit request and returns the parsed deposit", async () => {
    const deposit = makeDeposit();
    const fetchMock = stubFetch({ body: deposit, ok: true });

    await expect(
      createMemory({
        captureSource: "manual",
        noteText: "spill the beans",
        prompts: [{ cueText: "spill the beans" }]
      })
    ).resolves.toEqual(deposit);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes", {
      body: JSON.stringify({
        captureSource: "manual",
        noteText: "spill the beans",
        prompts: [{ cueText: "spill the beans" }]
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws on an invalid request", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(
      createMemory({ captureSource: "manual", noteText: "x", prompts: [{ cueText: "x" }] })
    ).rejects.toThrow("status 400");
  });
});

describe("importMemory", () => {
  it("posts the batch and returns the imported deposits", async () => {
    const deposit = makeDeposit();
    const fetchMock = stubFetch({ body: { imported: [deposit] }, ok: true });

    await expect(
      importMemory({
        items: [
          {
            captureSource: "import",
            noteText: "spill the beans",
            prompts: [{ cueText: "spill the beans" }]
          }
        ]
      })
    ).resolves.toEqual([deposit]);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/import", {
      body: JSON.stringify({
        items: [
          {
            captureSource: "import",
            noteText: "spill the beans",
            prompts: [{ cueText: "spill the beans" }]
          }
        ]
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the import fails", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(
      importMemory({
        items: [{ captureSource: "import", noteText: "x", prompts: [{ cueText: "x" }] }]
      })
    ).rejects.toThrow("status 500");
  });
});

describe("editMemoryNote", () => {
  it("patches the note body and returns the parsed detail", async () => {
    const detail = makeDetail();
    const fetchMock = stubFetch({ body: detail, ok: true });

    await expect(editMemoryNote("note-1", { noteText: "new body" })).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes/note-1", {
      body: JSON.stringify({ noteText: "new body" }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("throws when the note is missing", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(editMemoryNote("note-1", { noteText: "x" })).rejects.toThrow("status 404");
  });
});

describe("deleteMemoryNote", () => {
  it("sends a DELETE and resolves on 204", async () => {
    const fetchMock = stubFetch({ ok: true, status: 204 });

    await expect(deleteMemoryNote("note 1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes/note%201", { method: "DELETE" });
  });

  it("throws when the note is missing", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(deleteMemoryNote("note-1")).rejects.toThrow("status 404");
  });
});

describe("addPromptToNote", () => {
  it("posts a new direction and returns the parsed detail", async () => {
    const detail = makeDetail();
    const fetchMock = stubFetch({ body: detail, ok: true });

    await expect(
      addPromptToNote("note-1", { answerText: "to reveal", cueText: "spill the beans" })
    ).resolves.toEqual(detail);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/notes/note-1/prompts", {
      body: JSON.stringify({ answerText: "to reveal", cueText: "spill the beans" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws on an invalid direction", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(addPromptToNote("note-1", { cueText: "x" })).rejects.toThrow("status 400");
  });
});

describe("editMemoryPrompt", () => {
  it("patches the prompt and returns the parsed prompt", async () => {
    const prompt = makePrompt({ answerText: "to reveal", lifecycle: "ready" });
    const fetchMock = stubFetch({ body: prompt, ok: true });

    await expect(
      editMemoryPrompt("prompt-1", { answerText: "to reveal", cueText: "spill the beans" })
    ).resolves.toEqual(prompt);
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/prompts/prompt-1", {
      body: JSON.stringify({ answerText: "to reveal", cueText: "spill the beans" }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("throws when the prompt is missing", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(editMemoryPrompt("prompt-1", { cueText: "x" })).rejects.toThrow("status 404");
  });
});

describe("suggestGloss", () => {
  it("requests the suggest endpoint with an encoded term and returns the parsed suggestion", async () => {
    const suggestion = makeSuggestion();
    const fetchMock = stubFetch({ body: suggestion, ok: true });

    await expect(suggestGloss("spill the beans")).resolves.toEqual(suggestion);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/memory/suggest?term=spill%20the%20beans",
      undefined
    );
  });

  it("returns a null suggestion for an unknown term", async () => {
    const suggestion = makeSuggestion({ suggestion: null, term: "zzz" });
    stubFetch({ body: suggestion, ok: true });

    await expect(suggestGloss("zzz")).resolves.toEqual(suggestion);
  });

  it("throws on a blank term (400)", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(suggestGloss("  ")).rejects.toThrow("status 400");
  });
});
