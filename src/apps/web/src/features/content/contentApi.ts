import type {
  IngestMarkdownRequest,
  ReadingUnitContentDto,
  WorkContentDto,
  WorkListDto,
  WorkStructureDto
} from "@whetstone/contracts";

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

// The authoring panel needs a work's whole content. It is now assembled from the lightweight
// structure plus each reading unit's blocks fetched on demand, so the server no longer ships a
// dedicated whole-work content route. A reading unit's content DTO is structurally a reading
// unit, so the composed result is a `WorkContentDto`.
export async function fetchWorkContent(workEntryId: string): Promise<WorkContentDto> {
  const structure = await requestJson<WorkStructureDto>(
    `/api/works/${encodeURIComponent(workEntryId)}/structure`
  );
  const readingUnits = await Promise.all(
    structure.readingUnits.map((unit) =>
      requestJson<ReadingUnitContentDto>(
        `/api/works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(
          unit.entryId
        )}/content`
      )
    )
  );

  return { readingUnits, workEntryId: structure.workEntryId };
}

// Ingesting Markdown yields the work's new content, unless the Markdown has no readable blocks
// (e.g. image-only input — v0 has no image block), which the server reports as 422 `empty_content`
// so the panel can show an explicit unsupported-content message instead of a false success.
export type IngestMarkdownOutcome =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "empty_content" }>;

export async function ingestMarkdown(
  workEntryId: string,
  source: IngestMarkdownRequest
): Promise<IngestMarkdownOutcome> {
  const path = `/api/works/${encodeURIComponent(workEntryId)}/content`;
  const response = await fetch(path, {
    body: JSON.stringify(source),
    headers: jsonHeaders,
    method: "POST"
  });

  if (response.status === 422) {
    return { status: "empty_content" };
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return { content: (await response.json()) as WorkContentDto, status: "ingested" };
}
