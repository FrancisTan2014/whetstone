import type { WorkContentDto, WorkListDto } from "@whetstone/contracts";

// The reader keeps its own works/content fetch so it stays decoupled from the
// library admin and content authoring features.
async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

export async function fetchWorks(): Promise<WorkListDto> {
  return requestJson<WorkListDto>("/api/works");
}

export async function fetchWorkContent(workEntryId: string): Promise<WorkContentDto> {
  return requestJson<WorkContentDto>(`/api/works/${encodeURIComponent(workEntryId)}/content`);
}
