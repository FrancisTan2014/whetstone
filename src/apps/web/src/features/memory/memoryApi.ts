import {
  parseMemoryDepositDto,
  parseMemoryGlossSuggestionDto,
  parseMemoryNoteDetailDto,
  parseMemoryNoteListDto,
  parseMemoryPromptDto,
  type AddMemoryPromptRequest,
  type DepositMemoryRequest,
  type EditMemoryNoteRequest,
  type EditMemoryPromptRequest,
  type MemoryDepositDto,
  type MemoryGlossSuggestionDto,
  type MemoryNoteDetailDto,
  type MemoryNoteSummaryDto,
  type MemoryPromptDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The Memory feature keeps its own fetch helper so it stays decoupled from recall and the reader.
// Every response is parsed through the shared contracts schema, so a drifted server shape is caught at
// the boundary rather than surfacing as a render-time crash.
const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return response.json();
}

// The Memory list, or a note-centric search when a term is given. A blank/absent term returns the full
// list (the server trims); a non-blank term is passed through as `?q=`.
export async function listMemoryNotes(
  query?: string
): Promise<ReadonlyArray<MemoryNoteSummaryDto>> {
  const trimmed = query?.trim() ?? "";
  const path =
    trimmed.length === 0
      ? apiUrl("/memory/notes")
      : apiUrl(`/memory/notes?q=${encodeURIComponent(trimmed)}`);

  return parseMemoryNoteListDto(await requestJson(path)).items;
}

// One note's full detail: the note plus every prompt (draft or scheduled) under it.
export async function getMemoryNote(noteId: string): Promise<MemoryNoteDetailDto> {
  return parseMemoryNoteDetailDto(
    await requestJson(apiUrl(`/memory/notes/${encodeURIComponent(noteId)}`))
  );
}

// Create a Memory: one note and one-or-more retrieval directions. An answerless direction saves as an
// unscheduled draft, an answered one schedules.
export async function createMemory(request: DepositMemoryRequest): Promise<MemoryDepositDto> {
  return parseMemoryDepositDto(
    await requestJson(apiUrl("/memory/notes"), {
      body: JSON.stringify(request),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// Edit a note's durable body. Editing content never resets any prompt's review history (server rule).
export async function editMemoryNote(
  noteId: string,
  request: EditMemoryNoteRequest
): Promise<MemoryNoteDetailDto> {
  return parseMemoryNoteDetailDto(
    await requestJson(apiUrl(`/memory/notes/${encodeURIComponent(noteId)}`), {
      body: JSON.stringify(request),
      headers: jsonHeaders,
      method: "PATCH"
    })
  );
}

// Delete a note and everything under it; 204 with no body.
export async function deleteMemoryNote(noteId: string): Promise<void> {
  const path = apiUrl(`/memory/notes/${encodeURIComponent(noteId)}`);
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
}

// Add one additional retrieval direction to an existing note.
export async function addPromptToNote(
  noteId: string,
  request: AddMemoryPromptRequest
): Promise<MemoryNoteDetailDto> {
  return parseMemoryNoteDetailDto(
    await requestJson(apiUrl(`/memory/notes/${encodeURIComponent(noteId)}/prompts`), {
      body: JSON.stringify(request),
      headers: jsonHeaders,
      method: "POST"
    })
  );
}

// Edit one prompt's cue/answer; the server reconciles the schedule (keep card / seed / revert to draft).
export async function editMemoryPrompt(
  promptId: string,
  request: EditMemoryPromptRequest
): Promise<MemoryPromptDto> {
  return parseMemoryPromptDto(
    await requestJson(apiUrl(`/memory/prompts/${encodeURIComponent(promptId)}`), {
      body: JSON.stringify(request),
      headers: jsonHeaders,
      method: "PATCH"
    })
  );
}

// Quick Add's offline suggestion for a bare term: a bundled-dictionary back, or null when unknown.
export async function suggestGloss(term: string): Promise<MemoryGlossSuggestionDto> {
  return parseMemoryGlossSuggestionDto(
    await requestJson(apiUrl(`/memory/suggest?term=${encodeURIComponent(term)}`))
  );
}
