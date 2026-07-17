import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CreateNoteRequest,
  ImportNotesRequest,
  UpdateNoteRequest
} from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";
import { toEntryId } from "@whetstone/domain";

import {
  createMark,
  createNote,
  createStandaloneNote,
  deleteNote,
  deleteOwnedNote,
  fetchAllNotes,
  fetchNotes,
  importNotes,
  suggestGloss,
  updateNote,
  updateOwnedNote
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
  it("fetches all of the user's notes from the cross-work notes endpoint", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchAllNotes()).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", undefined);
  });

  it("posts a note to the work's notes endpoint", async () => {
    const note = { entryId: "note-1" };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request: CreateNoteRequest = {
      anchor: {
        blockEntryId: toEntryId("block 1"),
        contextSnapshot: "capitulate",
        endBlockEntryId: toEntryId("block 1"),
        selectedTextSnapshot: "capitulate"
      },
      bodyDoc: createTextDocument("to surrender")
    };

    await expect(createNote("work 1", request)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work%201/notes", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("posts a mark to the work's marks endpoint with only the anchor", async () => {
    const note = { entryId: "mark-1", kind: "mark" };
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

    await expect(fetchAllNotes()).rejects.toThrow("failed with status 400");
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
      bodyDoc: createTextDocument("to give in")
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

describe("notesApi owner-scoped (#659)", () => {
  it("narrows the notes list to a work without a search param", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchAllNotes({ workEntryId: "work 1" })).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes?work=work+1", undefined);
  });

  it("passes a trimmed, non-blank search across the note-centric endpoint", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchAllNotes({ search: "  surrender  " })).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes?search=surrender", undefined);
  });

  it("omits a blank search so the full list is restored", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchAllNotes({ search: "   " })).resolves.toEqual({ notes: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", undefined);
  });

  it("combines the work filter and the search term", async () => {
    const fetchMock = stubFetch({ body: { notes: [] }, ok: true });

    await expect(fetchAllNotes({ search: "fox", workEntryId: "work 1" })).resolves.toEqual({
      notes: []
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/notes?work=work+1&search=fox", undefined);
  });

  it("creates a standalone note on the owner-scoped notes endpoint", async () => {
    const note = { entryId: "note-1" };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request = { bodyDoc: createTextDocument("a standalone thought") };

    await expect(createStandaloneNote(request)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("patches an owned note on the owner-scoped note endpoint", async () => {
    const note = { entryId: "note-1" };
    const fetchMock = stubFetch({ body: note, ok: true });
    const request: UpdateNoteRequest = { bodyDoc: createTextDocument("edited") };

    await expect(updateOwnedNote("note 1", request)).resolves.toEqual(note);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/note%201", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("deletes an owned note on the owner-scoped note endpoint", async () => {
    const fetchMock = stubFetch({ ok: true });

    await expect(deleteOwnedNote("note 1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/note%201", { method: "DELETE" });
  });

  it("throws when an owned delete responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(deleteOwnedNote("note 1")).rejects.toThrow("failed with status 404");
  });
});

describe("notesApi import (#661)", () => {
  it("posts the batch to the atomic import endpoint and parses the ordered result", async () => {
    const body = { imported: [{ noteEntryId: "note-1", promptId: "prompt-1" }] };
    const fetchMock = stubFetch({ body, ok: true });
    const request: ImportNotesRequest = {
      items: [{ noteDoc: createTextDocument("each"), questionDoc: createTextDocument("per") }]
    };

    await expect(importNotes(request)).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/notes/import", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the import responds with a non-ok status, leaving the caller's paste intact", async () => {
    stubFetch({ ok: false, status: 400 });

    await expect(
      importNotes({
        items: [{ noteDoc: createTextDocument("n"), questionDoc: createTextDocument("q") }]
      })
    ).rejects.toThrow("failed with status 400");
  });

  it("reads a dictionary gloss for a term from the shared suggest endpoint", async () => {
    const fetchMock = stubFetch({
      body: { suggestion: "a happy accident", term: "serendipity" },
      ok: true
    });

    await expect(suggestGloss("serendipity")).resolves.toEqual({
      suggestion: "a happy accident",
      term: "serendipity"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/memory/suggest?term=serendipity", undefined);
  });
});
