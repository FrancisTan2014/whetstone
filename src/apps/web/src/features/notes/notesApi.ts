import type { CreateNoteRequest, NoteDto, NoteTemplateListDto } from "@whetstone/contracts";

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
