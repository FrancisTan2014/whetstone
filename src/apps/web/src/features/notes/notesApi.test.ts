import { afterEach, describe, expect, it, vi } from "vitest";

import type { CreateNoteRequest, UpdateNoteRequest } from "@whetstone/contracts";
import { toEntryId } from "@whetstone/domain";

import {
  createMark,
  createNote,
  deleteNote,
  fetchAllNotes,
  fetchNoteTemplates,
  fetchNotes,
  updateNote
} from "./notesApi";

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

  it("fetches all of the user's notes from the cross-work notes endpoint", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchAllNotes()).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", undefined);
  });

  it("posts a note to the work's notes endpoint", async () => {
    const note = { entryId: "note-1" };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request: CreateNoteRequest = {
      answers: { meaning: "to surrender" },
      anchor: {
        blockEntryId: toEntryId("block 1"),
        contextSnapshot: "capitulate",
        endBlockEntryId: toEntryId("block 1"),
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

  it("posts a mark to the work's marks endpoint with only the anchor", async () => {
    const note = { entryId: "mark-1", templateId: null };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request = {
      anchor: {
        blockEntryId: toEntryId("block 1"),
        contextSnapshot: "A great line.",
        endBlockEntryId: toEntryId("block 1"),
        selectedTextSnapshot: "great line"
      }
    };

    await expect(createMark("work 1", request)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/marks", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(fetchNoteTemplates()).rejects.toThrow("failed with status 400");
  });

  it("fetches the notes for a work", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchNotes("work 1")).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes", undefined);
  });

  it("patches a note on the note's endpoint", async () => {
    const note = { entryId: "note-1" };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request: UpdateNoteRequest = {
      answers: { meaning: "to give in" },
      templateId: "vocabulary"
    };

    await expect(updateNote("work 1", "note 1", request)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes/note%201", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("deletes a note on the note's endpoint", async () => {
    const fetchMock = stubFetch({ ok: true });

    await expect(deleteNote("work 1", "note 1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes/note%201", {
      method: "DELETE"
    });
  });

  it("throws when a delete responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(deleteNote("work 1", "note 1")).rejects.toThrow("failed with status 404");
  });
});
