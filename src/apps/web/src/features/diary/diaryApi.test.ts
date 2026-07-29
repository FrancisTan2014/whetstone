import { afterEach, describe, expect, it, vi } from "vitest";

import type { DiaryEntryDto } from "@whetstone/contracts";
import { createTextDocument } from "@whetstone/document";

import {
  deleteDiaryEntry,
  diaryEntryAudioUrl,
  fetchDiaryEntry,
  fetchTimeline,
  submitDiaryCapture,
  updateDiaryEntry
} from "./diaryApi";

const bodyDoc = createTextDocument("today I read a book");

const entry: DiaryEntryDto = {
  bodyDoc,
  bodyText: "today I read a book",
  createdAt: "2026-06-30T20:38:00.000Z",
  hasAudio: false,
  id: "diary-1",
  inputMode: "typed",
  language: null,
  occurredAt: "2026-06-30T20:38:00.000Z",
  processingStatus: null,
  transcript: null,
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
  it("posts the canonical body document to create a diary Entry and parses it (#678)", async () => {
    const fetchMock = stubFetch({ body: entry, ok: true });

    await expect(submitDiaryCapture(bodyDoc)).resolves.toEqual(entry);
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries", {
      body: JSON.stringify({ bodyDoc }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
  });

  it("sends the rich document intact — never a flattened transcript (#678)", async () => {
    const richDoc = {
      content: [
        { content: [{ text: "Heading", type: "text" }], type: "heading" },
        { content: [{ text: "body", type: "text" }], type: "paragraph" }
      ],
      type: "doc"
    };
    const fetchMock = stubFetch({ body: entry, ok: true });

    await submitDiaryCapture(richDoc);
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries", {
      body: JSON.stringify({ bodyDoc: richDoc }),
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

  it("fetches one diary entry full-state and parses it (#801)", async () => {
    const voice: DiaryEntryDto = {
      ...entry,
      hasAudio: true,
      id: "voice-1",
      inputMode: "voice",
      language: "en",
      processingStatus: "ready",
      transcript: "  today I walked  "
    };
    const fetchMock = stubFetch({ body: voice, ok: true });

    await expect(fetchDiaryEntry("voice-1")).resolves.toEqual(voice);
    expect(fetchMock).toHaveBeenCalledWith("/api/diary/entries/voice-1", undefined);
  });

  it("throws when fetching one entry fails", async () => {
    stubFetch({ ok: false, status: 404 });

    await expect(fetchDiaryEntry("voice-1")).rejects.toThrow("failed with status 404");
  });

  it("builds the owned-entry audio URL through the host base, encoding the id (#801)", () => {
    expect(diaryEntryAudioUrl("voice 1/2")).toBe("/api/diary/entries/voice%201%2F2/audio");
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
