import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiaryEntryDto } from "@whetstone/contracts";

import {
  createDiaryEntry,
  deleteDiaryEntry,
  fetchDiaryCalendar,
  fetchTimeline,
  updateDiaryEntry
} from "./diaryApi";

const entry: DiaryEntryDto = {
  createdAt: "2026-06-30T20:38:00.000Z",
  entryDate: "2026-06-30",
  id: "diary-1",
  language: null,
  text: "today I read a book"
};

function stubFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
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

describe("diaryApi", () => {
  it("posts a transcript to create an entry and parses the entry", async () => {
    const fetchMock = stubFetch({ body: entry, ok: true });

    await expect(createDiaryEntry("today I read a book")).resolves.toEqual(entry);
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries", {
      body: JSON.stringify({ transcript: "today I read a book" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("fetches the first timeline page without a cursor", async () => {
    const fetchMock = stubFetch({ body: { days: [] }, ok: true });

    await expect(fetchTimeline(undefined, 7)).resolves.toEqual({ days: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/timeline?limit=7", undefined);
  });

  it("fetches an older timeline page with the before cursor", async () => {
    const fetchMock = stubFetch({ body: { days: [] }, ok: true });

    await fetchTimeline("2026-06-20", 7);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diary/timeline?limit=7&before=2026-06-20",
      undefined
    );
  });

  it("fetches the calendar marks for a range", async () => {
    const fetchMock = stubFetch({ body: { dates: ["2026-06-10"] }, ok: true });

    await expect(fetchDiaryCalendar("2026-06-01", "2026-06-30")).resolves.toEqual({
      dates: ["2026-06-10"]
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/diary/calendar?from=2026-06-01&to=2026-06-30",
      undefined
    );
  });

  it("patches an entry's text", async () => {
    const fetchMock = stubFetch({ body: { ...entry, text: "edited" }, ok: true });

    await expect(updateDiaryEntry("diary-1", "edited")).resolves.toEqual({
      ...entry,
      text: "edited"
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries/diary-1", {
      body: JSON.stringify({ text: "edited" }),
      headers: { "content-type": "application/json" },
      method: "PATCH"
    });
  });

  it("deletes an entry", async () => {
    const fetchMock = stubFetch({ ok: true });

    await expect(deleteDiaryEntry("diary-1")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries/diary-1", { method: "DELETE" });
  });

  it("throws when a request fails", async () => {
    stubFetch({ ok: false, status: 500 });

    await expect(fetchTimeline(undefined, 7)).rejects.toThrow("failed with status 500");
  });

  it("throws when a delete fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(deleteDiaryEntry("diary-1")).rejects.toThrow("failed with status 404");
  });
});
