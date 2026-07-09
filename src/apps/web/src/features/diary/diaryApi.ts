import {
  parseDiaryCalendarDto,
  parseDiaryCaptureResultDto,
  parseDiaryEntryDto,
  parseTimelineDto,
  type CaptureInputMode,
  type DiaryCalendarDto,
  type DiaryCaptureResultDto,
  type DiaryEntryDto,
  type TimelineDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

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

// Capture: post the transcript; the server tidies it, files it as a diary entry, and may return one
// Make Durable review card. `inputMode` is accepted by the unified UI seam; diary capture storage keeps
// the existing server-side shape for this slice.
export async function submitDiaryCapture(
  transcript: string,
  _inputMode: CaptureInputMode
): Promise<DiaryCaptureResultDto> {
  return parseDiaryCaptureResultDto(
    await requestJson(apiUrl("/diary/entries"), {
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

  return parseTimelineDto(await requestJson(apiUrl(`/diary/timeline?${params.toString()}`)));
}

// The date-jump calendar's marks: which days in `[from, to]` have ≥1 entry.
export async function fetchDiaryCalendar(from: string, to: string): Promise<DiaryCalendarDto> {
  const params = new URLSearchParams({ from, to });

  return parseDiaryCalendarDto(await requestJson(apiUrl(`/diary/calendar?${params.toString()}`)));
}

export async function updateDiaryEntry(id: string, text: string): Promise<DiaryEntryDto> {
  return parseDiaryEntryDto(
    await requestJson(apiUrl(`/diary/entries/${encodeURIComponent(id)}`), {
      body: JSON.stringify({ text }),
      headers: jsonHeaders,
      method: "PATCH"
    })
  );
}

export async function deleteDiaryEntry(id: string): Promise<void> {
  const path = apiUrl(`/diary/entries/${encodeURIComponent(id)}`);
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
}
