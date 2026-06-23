import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateNoteRequest } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import { createNote, fetchNoteTemplates } from "./notesApi";

function stubFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? 200,
    json: async () => response.body
  }));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("notesApi", () => {
  it("fetches note templates from the templates endpoint", async () => {
    const fetchMock = stubFetch({ body: { templates: [] }, ok: true });

    await expect(fetchNoteTemplates()).resolves.toEqual({ templates: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/note-templates", undefined);
  });

  it("posts a note to the work's notes endpoint", async () => {
    const note = { entryId: "note-1" };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request: CreateNoteRequest = {
      answers: { meaning: "to surrender" },
      anchor: {
        blockEntryId: toEntryId("block 1"),
        contextSnapshot: "capitulate",
        selectedTextSnapshot: "capitulate"
      },
      templateId: "vocabulary"
    };

    await expect(createNote("work 1", request)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(fetchNoteTemplates()).rejects.toThrow("failed with status 400");
  });
});
