import {
  parseDiaryCalendarDto,
  parseDiaryEntryDto,
  parseTimelineDto,
  type CaptureLanguage,
  type CaptureInputMode,
  type DiaryCalendarDto,
  type DiaryEntryDto,
  type TimelineDto
} from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

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

// Capture: post the transcript and how it was entered (`inputMode`: typed box vs tap-and-talk voice).
// A diary capture journals only (#571) — the server saves it as a rich diary Entry immediately (no
// proposal step) and returns that Entry.
export async function submitDiaryCapture(
  transcript: string,
  inputMode: CaptureInputMode,
  language: CaptureLanguage
): Promise<DiaryEntryDto> {
  return parseDiaryEntryDto(
    await requestJson(apiUrl("/diary/entries"), {
      body: JSON.stringify({ inputMode, language, transcript }),
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

// Edit a diary Entry's rich body through the shared editor: PATCH the new ProseMirror/Tiptap document.
export async function updateDiaryEntry(
  id: string,
  bodyDoc: DocumentNodeJSON
): Promise<DiaryEntryDto> {
  return parseDiaryEntryDto(
    await requestJson(apiUrl(`/diary/entries/${encodeURIComponent(id)}`), {
      body: JSON.stringify({ bodyDoc }),
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
