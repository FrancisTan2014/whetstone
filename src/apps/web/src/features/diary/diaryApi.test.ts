import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiaryEntryDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import {
  deleteDiaryEntry,
  fetchDiaryCalendar,
  fetchTimeline,
  submitDiaryCapture,
  updateDiaryEntry
} from "./diaryApi";

const bodyDoc = createTextDocument("today I read a book");

const entry: DiaryEntryDto = {
  bodyDoc,
  bodyText: "today I read a book",
  createdAt: "2026-06-30T20:38:00.000Z",
  failureReason: null,
  id: "diary-1",
  inputMode: "typed",
  language: null,
  occurredAt: "2026-06-30T20:38:00.000Z",
  processingStatus: null,
  updatedAt: "2026-06-30T20:38:00.000Z"
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
  it("posts the transcript and input mode to create a diary Entry and parses it (#571)", async () => {
    const fetchMock = stubFetch({ body: entry, ok: true });

    await expect(submitDiaryCapture("today I read a book", "typed")).resolves.toEqual(entry);
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries", {
      body: JSON.stringify({
        inputMode: "typed",
        transcript: "today I read a book"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("threads a voice input mode through to the capture request (#560)", async () => {
    const fetchMock = stubFetch({ body: entry, ok: true });

    await submitDiaryCapture("spoken out loud", "voice");
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries", {
      body: JSON.stringify({ inputMode: "voice", transcript: "spoken out loud" }),
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

  it("patches an entry's rich body document (#571)", async () => {
    const editedDoc = createTextDocument("edited");
    const updated = { ...entry, bodyDoc: editedDoc, bodyText: "edited" };
    const fetchMock = stubFetch({ body: updated, ok: true });

    await expect(updateDiaryEntry("diary-1", editedDoc)).resolves.toEqual(updated);
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries/diary-1", {
      body: JSON.stringify({ bodyDoc: editedDoc }),
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
