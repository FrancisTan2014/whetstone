import {
  parseDiaryCalendarDto,
  parseDiaryEntryDto,
  parseTimelineDto,
  type DiaryCalendarDto,
  type DiaryEntryDto,
  type TimelineDto
} from "@whetstone/contracts";

// The diary keeps its own fetch helper so it stays decoupled from the session, notes, and reader
// features. Every response is parsed through the shared contracts schema, so a drifted server shape is
// caught at the boundary rather than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// Capture: post the STT transcript; the server tidies it and files it under today.
export async function createDiaryEntry(transcript: string): Promise<DiaryEntryDto> {
  return parseDiaryEntryDto(
    await requestJson("/api/diary/entries", {
      body: JSON.stringify({ transcript }),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// One lazy-loaded Timeline page: the days strictly before `before` (omitted on the first page), bounded
// to `limit` days, newest-first.
export async function fetchTimeline(
  before: string | undefined,
  limit: number
): Promise<TimelineDto> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before !== undefined) {
    params.set("before", before);
  }

  return parseTimelineDto(await requestJson(`/api/diary/timeline?${params.toString()}`));
}

// The date-jump calendar's marks: which days in `[from, to]` have ≥1 entry.
export async function fetchDiaryCalendar(from: string, to: string): Promise<DiaryCalendarDto> {
  const params = new URLSearchParams({ from, to });

  return parseDiaryCalendarDto(await requestJson(`/api/diary/calendar?${params.toString()}`));
}

export async function updateDiaryEntry(id: string, text: string): Promise<DiaryEntryDto> {
  return parseDiaryEntryDto(
    await requestJson(`/api/diary/entries/${encodeURIComponent(id)}`, {
      body: JSON.stringify({ text }),
      headers: jsonHeaders,
      method: "PATCH"
    })
  );
}

export async function deleteDiaryEntry(id: string): Promise<void> {
  const path = `/api/diary/entries/${encodeURIComponent(id)}`;
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
}
