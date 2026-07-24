import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginMarkdownCreation,
  cancelWorkCreation,
  createAuthor,
  createWork,
  deleteWork,
  fetchWorkCreationReview,
  fetchWorks,
  fetchWorksWithReadingPosition,
  ingestEpub,
  keepSeparateWork,
  openExistingWork,
  searchAuthors
} from "./libraryApi";

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

describe("libraryApi", () => {
  it("searches authors with a blank query against the plain authors endpoint", async () => {
    const body = { authors: [], cleanedQuery: "", exactMatchId: null };
    const fetchMock = stubFetch({ ok: true, body });

    await expect(searchAuthors()).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/authors", undefined);
  });

  it("treats a whitespace-only query as blank", async () => {
    const body = { authors: [], cleanedQuery: "", exactMatchId: null };
    const fetchMock = stubFetch({ ok: true, body });

    await expect(searchAuthors("   ")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/authors", undefined);
  });

  it("passes a nonblank query as an encoded querystring", async () => {
    const body = {
      authors: [{ id: "author-1", name: "Octavia Butler" }],
      cleanedQuery: "octavia butler",
      exactMatchId: "author-1"
    };
    const fetchMock = stubFetch({ ok: true, body });

    await expect(searchAuthors("Octavia Butler")).resolves.toEqual(body);
    expect(fetchMock).toHaveBeenCalledWith("/api/authors?query=Octavia%20Butler", undefined);
  });

  it("fetches works from the works endpoint", async () => {
    const fetchMock = stubFetch({ ok: true, body: { works: [] } });

    await expect(fetchWorks()).resolves.toEqual({ works: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/works", undefined);
  });

  it("fetches the set of works with a saved reading position", async () => {
    const fetchMock = stubFetch({ ok: true, body: { workEntryIds: ["work-1", "work-3"] } });

    const set = await fetchWorksWithReadingPosition();

    expect(fetchMock).toHaveBeenCalledWith("/api/reading-position/works");
    expect([...set]).toEqual(["work-1", "work-3"]);
    expect(set.has("work-1")).toBe(true);
    expect(set.has("work-2")).toBe(false);
  });

  it("throws when the works-with-position request fails", async () => {
    stubFetch({ ok: false, status: 503, body: undefined });

    await expect(fetchWorksWithReadingPosition()).rejects.toThrow("failed with status 503");
  });

  it("posts a new author and returns the created author", async () => {
    const fetchMock = stubFetch({ ok: true, body: { id: "author-1", name: "Ada Lovelace" } });

    await expect(createAuthor({ name: "Ada Lovelace" })).resolves.toEqual({
      id: "author-1",
      name: "Ada Lovelace"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/authors", {
      body: JSON.stringify({ name: "Ada Lovelace" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("posts a new work and returns the created work item", async () => {
    const work = {
      author: { id: "author-1", name: "Ada Lovelace" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        title: "Notes",
        workType: "essay"
      }
    };
    const fetchMock = stubFetch({ ok: true, body: work });

    await expect(
      createWork({
        author: { mode: "new", name: "Ada Lovelace" },
        language: "en",
        origin: "manual",
        title: "Notes",
        workType: "essay"
      })
    ).resolves.toEqual(work);
    expect(fetchMock).toHaveBeenCalledWith("/api/works", {
      body: JSON.stringify({
        author: { mode: "new", name: "Ada Lovelace" },
        language: "en",
        origin: "manual",
        title: "Notes",
        workType: "essay"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("throws when the server responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 500, body: undefined });

    await expect(searchAuthors()).rejects.toThrow("failed with status 500");
  });

  it("posts EPUB bytes to the epub endpoint and reports it created on 201", async () => {
    const result = {
      content: { readingUnits: [], workEntryId: "work-1" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "zh-CN",
        title: "史记选读",
        workType: "book"
      }
    };
    const fetchMock = stubFetch({ ok: true, status: 201, body: result });
    const file = new File([new Uint8Array([1, 2, 3])], "book.epub", {
      type: "application/epub+zip"
    });

    await expect(ingestEpub(file)).resolves.toEqual({ result, status: "created" });

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("/api/works/epub");
    expect(call[1].method).toBe("POST");
    expect(call[1].headers).toEqual({ "content-type": "application/epub+zip" });
    expect(new Uint8Array(call[1].body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("reports exact_existing when identical EPUB bytes reopen the owning Work (200)", async () => {
    const result = {
      content: { readingUnits: [], workEntryId: "work-1" },
      work: { entryId: "work-1" }
    };
    stubFetch({ ok: true, status: 200, body: result });
    const file = new File([new Uint8Array([1, 2, 3])], "book.epub", {
      type: "application/epub+zip"
    });

    await expect(ingestEpub(file)).resolves.toEqual({ result, status: "exact_existing" });
  });

  it("throws when the epub endpoint responds with a non-ok status", async () => {
    stubFetch({ ok: false, status: 500, body: undefined });
    const file = new File([new Uint8Array([1, 2, 3])], "book.epub", {
      type: "application/epub+zip"
    });

    await expect(ingestEpub(file)).rejects.toThrow("failed with status 500");
  });

  const markdownRequest = {
    author: { mode: "new" as const, name: "George Orwell" },
    fileName: "politics.md",
    language: "en" as const,
    markdown: "# Politics",
    title: "Politics and the English Language",
    workType: "book" as const
  };

  const reviewDto = {
    attemptId: "attempt-1",
    candidateFingerprint: "fp-1",
    candidates: [
      {
        author: { id: "author-2", name: "George Orwell" },
        entryId: "work-2",
        evidence: {
          editionMarkerDifferences: ["2nd"],
          languageDiffers: false,
          sameAuthor: true,
          titleSimilarity: 0.91,
          workTypeDiffers: false
        },
        language: "en" as const,
        matchTier: "same_author_fuzzy" as const,
        origin: "imported" as const,
        title: "Politics and the English Language",
        workType: "book" as const
      }
    ],
    proposed: {
      authorName: "George Orwell",
      language: "en" as const,
      title: "Politics and the English Language",
      workType: "book" as const
    },
    revision: 0,
    sourceFileName: "politics.md"
  };

  it("begins a Markdown Work and reports it created (no credible candidate)", async () => {
    const result = {
      content: { readingUnits: [], workEntryId: "work-1" },
      work: {
        authorId: "author-1",
        entryId: "work-1",
        language: "en",
        origin: "imported",
        title: "Politics and the English Language",
        workType: "book"
      }
    };
    const fetchMock = stubFetch({ ok: true, status: 201, body: { result, status: "created" } });

    await expect(beginMarkdownCreation(markdownRequest)).resolves.toEqual({
      result,
      status: "created"
    });

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("/api/works/markdown");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body as string)).toMatchObject({
      fileName: "politics.md",
      markdown: "# Politics"
    });
  });

  it("reports exact_existing when identical bytes reopen the owning Work", async () => {
    const result = {
      content: { readingUnits: [], workEntryId: "work-1" },
      work: { entryId: "work-1" }
    };
    stubFetch({ ok: true, status: 200, body: { result, status: "exact_existing" } });

    await expect(beginMarkdownCreation(markdownRequest)).resolves.toEqual({
      result,
      status: "exact_existing"
    });
  });

  it("parses and returns the review when a credible candidate needs review", async () => {
    stubFetch({ ok: true, status: 200, body: { review: reviewDto, status: "needs_review" } });

    await expect(beginMarkdownCreation(markdownRequest)).resolves.toEqual({
      review: reviewDto,
      status: "needs_review"
    });
  });

  it("surfaces empty_content, author_not_found, and uncertain begin outcomes as data", async () => {
    for (const status of ["empty_content", "author_not_found", "uncertain"] as const) {
      stubFetch({ ok: status !== "uncertain", body: { status } });
      await expect(beginMarkdownCreation(markdownRequest)).resolves.toEqual({ status });
    }
  });

  it("throws when begin returns an unrecognized outcome", async () => {
    stubFetch({ ok: true, body: { status: "surprise" } });

    await expect(beginMarkdownCreation(markdownRequest)).rejects.toThrow(
      "unexpected begin outcome"
    );
  });

  it("fetches the current review view for an attempt", async () => {
    const fetchMock = stubFetch({ ok: true, body: reviewDto });

    await expect(fetchWorkCreationReview("attempt-1")).resolves.toEqual({
      review: reviewDto,
      status: "ok"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/work-creation-attempts/attempt-1");
  });

  it("surfaces expired, uncertain, and not_found review lookups as named states", async () => {
    for (const status of ["expired", "uncertain", "not_found"] as const) {
      stubFetch({ ok: false, body: { status } });
      await expect(fetchWorkCreationReview("attempt-1")).resolves.toEqual({ status });
    }
  });

  it("throws when a failed review lookup carries no recognized state", async () => {
    stubFetch({ ok: false, status: 500, body: { error: "boom" } });

    await expect(fetchWorkCreationReview("attempt-1")).rejects.toThrow("failed with status 500");
  });

  it("posts an Open existing decision and returns the reopened Work", async () => {
    const result = {
      content: { readingUnits: [], workEntryId: "work-2" },
      work: { entryId: "work-2" }
    };
    const fetchMock = stubFetch({ ok: true, body: { result, status: "opened" } });

    await expect(
      openExistingWork("attempt-1", { entryId: "work-2", revision: 0 })
    ).resolves.toEqual({ result, status: "opened" });

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("/api/work-creation-attempts/attempt-1/open-existing");
    expect(JSON.parse(call[1].body as string)).toEqual({ entryId: "work-2", revision: 0 });
  });

  it("posts a Keep separate decision and returns the created Work", async () => {
    const result = {
      content: { readingUnits: [], workEntryId: "work-3" },
      work: { entryId: "work-3" }
    };
    const fetchMock = stubFetch({ ok: true, status: 201, body: { result, status: "created" } });

    await expect(keepSeparateWork("attempt-1", { revision: 1 })).resolves.toEqual({
      result,
      status: "created"
    });

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("/api/work-creation-attempts/attempt-1/keep-separate");
    expect(JSON.parse(call[1].body as string)).toEqual({ revision: 1 });
  });

  it("returns a refreshed review when a decision surfaces changed evidence", async () => {
    stubFetch({ ok: true, body: { review: reviewDto, status: "needs_review" } });

    await expect(keepSeparateWork("attempt-1", { revision: 0 })).resolves.toEqual({
      review: reviewDto,
      status: "needs_review"
    });
  });

  it("surfaces each non-committing decision state as data", async () => {
    for (const status of [
      "existing_gone",
      "expired",
      "superseded",
      "uncertain",
      "not_found"
    ] as const) {
      stubFetch({ ok: false, body: { status } });
      await expect(
        openExistingWork("attempt-1", { entryId: "work-2", revision: 0 })
      ).resolves.toEqual({ status });
    }
  });

  it("throws when a decision returns an unrecognized outcome", async () => {
    stubFetch({ ok: true, body: { status: "surprise" } });

    await expect(keepSeparateWork("attempt-1", { revision: 0 })).rejects.toThrow(
      "unexpected decision outcome"
    );
  });

  it("cancels an attempt and returns whether it was cancelled", async () => {
    const fetchMock = stubFetch({ ok: true, body: { cancelled: true } });

    await expect(cancelWorkCreation("attempt-1")).resolves.toEqual({ cancelled: true });
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe("/api/work-creation-attempts/attempt-1/cancel");
    expect(call[1].method).toBe("POST");
  });

  it("throws when cancelling an attempt fails", async () => {
    stubFetch({ ok: false, status: 500, body: undefined });

    await expect(cancelWorkCreation("attempt-1")).rejects.toThrow("failed with status 500");
  });

  it("sends a DELETE to the work endpoint and resolves on success", async () => {
    const fetchMock = stubFetch({ ok: true, status: 204 });

    await expect(deleteWork("work-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/works/work-1", { method: "DELETE" });
  });

  it("throws when deleting a work fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(deleteWork("missing")).rejects.toThrow("failed with status 404");
  });
});
