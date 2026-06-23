import type {
  CreateNoteRequest,
  NoteDto,
  NoteListDto,
  NoteTemplateListDto,
  UpdateNoteRequest
} from "@whetstone/contracts";

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

export async function fetchNoteTemplates(): Promise<NoteTemplateListDto> {
  return requestJson<NoteTemplateListDto>("/api/note-templates");
}

export async function fetchNotes(workEntryId: string): Promise<NoteListDto> {
  return requestJson<NoteListDto>(`/api/works/${encodeURIComponent(workEntryId)}/notes`);
}

export async function createNote(
  workEntryId: string,
  request: CreateNoteRequest
): Promise<NoteDto> {
  return requestJson<NoteDto>(`/api/works/${encodeURIComponent(workEntryId)}/notes`, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

export async function updateNote(
  workEntryId: string,
  noteEntryId: string,
  request: UpdateNoteRequest
): Promise<NoteDto> {
  const path = `/api/works/${encodeURIComponent(workEntryId)}/notes/${encodeURIComponent(
    noteEntryId
  )}`;

  return requestJson<NoteDto>(path, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "PATCH"
  });
}

export async function deleteNote(workEntryId: string, noteEntryId: string): Promise<void> {
  const path = `/api/works/${encodeURIComponent(workEntryId)}/notes/${encodeURIComponent(
    noteEntryId
  )}`;
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
}
