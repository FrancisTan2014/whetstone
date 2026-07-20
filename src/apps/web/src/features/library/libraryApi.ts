import { epubContentType } from "@whetstone/contracts";
import type {
  AuthorDto,
  AuthorSearchDto,
  CreateAuthorRequest,
  CreateWorkRequest,
  IngestEpubResultDto,
  WorkListDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { parseWorksWithReadingPositionResponse } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

// Search the canonical author/source list (#694). A blank query returns the alphabetical list; a nonblank
// one returns canonical-key substring matches plus the exact-match id and cleaned name. The server owns
// all cleaning and matching, so the client never canonicalizes.
export async function searchAuthors(query?: string): Promise<AuthorSearchDto> {
  const trimmed = query?.trim() ?? "";
  const path =
    trimmed === ""
      ? apiUrl("/authors")
      : apiUrl(`/authors?query=${encodeURIComponent(query ?? "")}`);

  return requestJson<AuthorSearchDto>(path);
}

export async function fetchWorks(): Promise<WorkListDto> {
  return requestJson<WorkListDto>(apiUrl("/works"));
}

// The set of works the current user has a saved reading position for, so each shelf card can offer
// "Continue" only when one truly exists (and "Read" otherwise). One request answers the whole shelf;
// the response is validated at the boundary before the shelf trusts it.
export async function fetchWorksWithReadingPosition(): Promise<ReadonlySet<string>> {
  const path = apiUrl("/reading-position/works");
  const response = await fetch(path);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  const { workEntryIds } = parseWorksWithReadingPositionResponse(await response.json());

  return new Set(workEntryIds);
}

export async function createAuthor(request: CreateAuthorRequest): Promise<AuthorDto> {
  return requestJson<AuthorDto>(apiUrl("/authors"), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

export async function createWork(request: CreateWorkRequest): Promise<WorkListItemDto> {
  return requestJson<WorkListItemDto>(apiUrl("/works"), {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });
}

export async function ingestEpub(file: File): Promise<IngestEpubResultDto> {
  const bytes = new Uint8Array(await file.arrayBuffer());

  return requestJson<IngestEpubResultDto>(apiUrl("/works/epub"), {
    body: bytes,
    headers: { "content-type": epubContentType },
    method: "POST"
  });
}

// Permanently delete a work and its content (#541). A 204 resolves; a 404 (unknown work) or any other
// non-ok status throws so the caller can surface a failure toast.
export async function deleteWork(workEntryId: string): Promise<void> {
  const path = apiUrl(`/works/${encodeURIComponent(workEntryId)}`);
  const response = await fetch(path, { method: "DELETE" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }
}
