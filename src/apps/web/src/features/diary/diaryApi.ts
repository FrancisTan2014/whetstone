import {
  parseDiaryEntryDto,
  parseTimelineDto,
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

// Typed capture: post the canonical rich document the learner authored in the shared editor. The document
// crosses the boundary intact (#678) — never flattened to a transcript string and rebuilt server-side. A
// diary capture journals only (#571): the server saves it as a rich diary Entry immediately (no proposal
// step), fixes `inputMode = typed` itself, derives the plaintext projection, and returns that Entry. No
// capture language is sent: typed capture needs none (voice auto-detects it, #647).
export async function submitDiaryCapture(bodyDoc: DocumentNodeJSON): Promise<DiaryEntryDto> {
  return parseDiaryEntryDto(
    await requestJson(apiUrl("/diary/entries"), {
      body: JSON.stringify({ bodyDoc }),
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
