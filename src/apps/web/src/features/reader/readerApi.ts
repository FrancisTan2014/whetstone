import type {
  BlockUnitLocatorDto,
  ReadingUnitContentDto,
  WorkAnchorIndexDto,
  WorkListDto,
  WorkStructureDto
} from "@whetstone/contracts";

// The reader keeps its own works/structure/unit fetch so it stays decoupled from the
// library admin and content authoring features. It loads a work's lightweight structure
// first and fetches each reading unit's blocks on demand, rather than transferring the
// whole work up front.
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

// The lightweight outline fetched first: reading units + block counts, no content.
export async function fetchWorkStructure(workEntryId: string): Promise<WorkStructureDto> {
  return requestJson<WorkStructureDto>(`/api/works/${encodeURIComponent(workEntryId)}/structure`);
}

// The work's anchor index: every addressable block reachable by a source-HTML id, keyed at the
// consumer by (sourceFile, anchor), so the reader resolves a cross-reference to another unit and
// jumps there via `jumpToBlock` (#366). Fetched once alongside the structure when a work opens.
export async function fetchWorkAnchorIndex(workEntryId: string): Promise<WorkAnchorIndexDto> {
  return requestJson<WorkAnchorIndexDto>(`/api/works/${encodeURIComponent(workEntryId)}/anchors`);
}

// One reading unit's blocks, fetched on demand when that unit becomes active.
export async function fetchUnitContent(
  workEntryId: string,
  unitEntryId: string
): Promise<ReadingUnitContentDto> {
  return requestJson<ReadingUnitContentDto>(
    `/api/works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(unitEntryId)}/content`
  );
}

// Resolves a block to its owning reading unit so a deep-link (`?block=`) or a jump to a
// note/highlight can open the right unit without holding every block client-side. A 404
// (unknown, soft-deleted, or other-work block) returns undefined so the caller no-ops; any
// other failure throws.
export async function locateBlockUnit(
  workEntryId: string,
  blockEntryId: string
): Promise<string | undefined> {
  const path = `/api/works/${encodeURIComponent(workEntryId)}/blocks/${encodeURIComponent(
    blockEntryId
  )}/unit`;
  const response = await fetch(path);

  if (response.status === 404) {
    return undefined;
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return ((await response.json()) as BlockUnitLocatorDto).unitEntryId;
}
