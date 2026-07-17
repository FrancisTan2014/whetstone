import type {
  AnchoredNoteDto,
  CreateMarkRequest,
  CreateNoteRequest,
  CreateStandaloneNoteRequest,
  NoteDto,
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

// Optional narrowing for the Notes home (#659): restrict to one Work's anchored notes, and/or a
// note-centric search. Neither changes the server's stable recency order.
export type NotesQuery = Readonly<{
  search?: string | undefined;
  workEntryId?: string | undefined;
}>;

// Every note the current user owns — the single Notes home (#659), in recency order. `workEntryId`
// narrows to that one work's anchored notes; a non-blank `search` restricts to notes matching across
// body, anchor snapshot, prompt questions, and legacy answers (the server owns the match).
export async function fetchAllNotes(query: NotesQuery = {}): Promise<NotesOverviewListDto> {
  const params = new URLSearchParams();
  if (query.workEntryId !== undefined) {
    params.set("work", query.workEntryId);
  }
  const search = query.search?.trim();
  if (search !== undefined && search.length > 0) {
    params.set("search", search);
  }
  const suffix = params.toString();
  return requestJson<NotesOverviewListDto>(apiUrl(suffix === "" ? "/notes" : `/notes?${suffix}`));
}

// Create a standalone note (#659): one non-blank rich body, no anchor. The server stamps
// `kind = note`, `capture_source = manual` and derives the readable text.
export async function createStandaloneNote(request: CreateStandaloneNoteRequest): Promise<NoteDto> {
  return requestJson<NoteDto>(apiUrl("/notes"), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

// Edit any owned note's canonical body (#659), owner-scoped so a standalone note edits too. The server
// re-derives `body_text` and bumps `updated_at`; the anchor, if any, is unchanged.
export async function updateOwnedNote(
  noteEntryId: string,
  request: UpdateNoteRequest
): Promise<NoteDto> {
  return requestJson<NoteDto>(apiUrl(`/notes/${encodeURIComponent(noteEntryId)}`), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "PATCH"
  });
}

// Delete any owned note (#659) through the owner-scoped cascade. A 204 carries no body.
export async function deleteOwnedNote(noteEntryId: string): Promise<void> {
  const path = apiUrl(`/notes/${encodeURIComponent(noteEntryId)}`);
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
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
