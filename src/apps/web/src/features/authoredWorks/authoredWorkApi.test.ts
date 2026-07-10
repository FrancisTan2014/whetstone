import { createTextDocument } from "@whetstone/document";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAuthoredWork,
  fetchAuthoredWork,
  fetchContinueWriting,
  listAuthoredWorks,
  saveAuthoredWorkContent
} from "./authoredWorkApi";

const document = createTextDocument("Hello");

const workDto = {
  createdAt: "2026-07-01T00:00:00.000Z",
  document,
  entryId: "work-1",
  language: "en",
  title: "My draft",
  unitEntryId: "unit-1",
  updatedAt: "2026-07-02T00:00:00.000Z",
  workType: "book"
} as const;

const summaryDto = {
  createdAt: "2026-07-01T00:00:00.000Z",
  entryId: "work-1",
  language: "en",
  title: "My draft",
  updatedAt: "2026-07-02T00:00:00.000Z",
  workType: "book"
} as const;

function mockFetchOnce(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValue({
    json: async () => body,
    ok,
    status
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("authoredWorkApi", () => {
  it("creates an authored work, POSTing the request and parsing the returned work", async () => {
    const fetchMock = mockFetchOnce(workDto, true, 201);

    const result = await createAuthoredWork({
      language: "en",
      title: "My draft",
      workType: "book"
    });

    expect(result.entryId).toBe("work-1");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/authored-works");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      language: "en",
      title: "My draft",
      workType: "book"
    });
  });

  it("fetches one authored work by id, encoding the id in the path", async () => {
    const fetchMock = mockFetchOnce(workDto);

    const result = await fetchAuthoredWork("work/1");

    expect(result.title).toBe("My draft");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/authored-works/work%2F1");
  });

  it("saves content with a PUT carrying the document and returns the persisted work", async () => {
    const fetchMock = mockFetchOnce(workDto);

    const result = await saveAuthoredWorkContent("work-1", document);

    expect(result.entryId).toBe("work-1");
    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/authored-works/work-1/content");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ document });
  });

  it("lists authored works", async () => {
    mockFetchOnce({ works: [summaryDto] });

    const result = await listAuthoredWorks();

    expect(result.works).toHaveLength(1);
    expect(result.works[0]?.entryId).toBe("work-1");
  });

  it("fetches the continue-writing target, tolerating a null work", async () => {
    mockFetchOnce({ work: null });

    const result = await fetchContinueWriting();

    expect(result.work).toBeNull();
  });

  it("throws when a request is not ok", async () => {
    mockFetchOnce({}, false, 500);

    await expect(listAuthoredWorks()).rejects.toThrow(/failed with status 500/);
  });
});
