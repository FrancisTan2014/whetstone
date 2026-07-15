import type {
  AnchoredNoteDto,
  CreateMarkRequest,
  CreateNoteRequest,
  NoteListDto,
  NotesOverviewListDto,
  UpdateNoteRequest
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

const jsonHeaders = { "content-type": "application/json" } as const;

// The notes feature keeps its own fetch helper so it stays decoupled from the reader,
// library, and content features.
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function fetchNotes(workEntryId: string): Promise<NoteListDto> {
  return requestJson<NoteListDto>(apiUrl(`/works/${encodeURIComponent(workEntryId)}/notes`));
}

// Every note the current user owns across all works, for the cross-work Notes mode.
export async function fetchAllNotes(): Promise<NotesOverviewListDto> {
  return requestJson<NotesOverviewListDto>(apiUrl("/notes"));
}

export async function createNote(
  workEntryId: string,
  request: CreateNoteRequest
): Promise<AnchoredNoteDto> {
  return requestJson<AnchoredNoteDto>(apiUrl(`/works/${encodeURIComponent(workEntryId)}/notes`), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

// Save a mark-only highlight (a "Gem", #255): one POST with just the anchor, no template/body.
export async function createMark(
  workEntryId: string,
  request: CreateMarkRequest
): Promise<AnchoredNoteDto> {
  return requestJson<AnchoredNoteDto>(apiUrl(`/works/${encodeURIComponent(workEntryId)}/marks`), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

export async function updateNote(
  workEntryId: string,
  noteEntryId: string,
  request: UpdateNoteRequest
): Promise<AnchoredNoteDto> {
  const path = apiUrl(
    `/works/${encodeURIComponent(workEntryId)}/notes/${encodeURIComponent(noteEntryId)}`
  );

  return requestJson<AnchoredNoteDto>(path, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "PATCH"
  });
}

export async function deleteNote(workEntryId: string, noteEntryId: string): Promise<void> {
  const path = apiUrl(
    `/works/${encodeURIComponent(workEntryId)}/notes/${encodeURIComponent(noteEntryId)}`
  );
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
}
