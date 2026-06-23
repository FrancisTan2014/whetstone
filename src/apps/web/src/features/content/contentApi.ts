import type { IngestMarkdownRequest, WorkContentDto, WorkListDto } from "@whetstone/contracts";

const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

// The content feature keeps its own works fetch so it stays decoupled from the
// library admin feature.
export async function fetchWorks(): Promise<WorkListDto> {
  return requestJson<WorkListDto>("/api/works");
}

export async function fetchWorkContent(workEntryId: string): Promise<WorkContentDto> {
  return requestJson<WorkContentDto>(`/api/works/${encodeURIComponent(workEntryId)}/content`);
}

export async function ingestMarkdown(
  workEntryId: string,
  source: IngestMarkdownRequest
): Promise<WorkContentDto> {
  return requestJson<WorkContentDto>(`/api/works/${encodeURIComponent(workEntryId)}/content`, {
    body: JSON.stringify(source),
    headers: jsonHeaders,
    method: "POST"
  });
}
