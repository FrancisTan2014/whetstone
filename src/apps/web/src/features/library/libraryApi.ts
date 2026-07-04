import { epubContentType } from "@whetstone/contracts";
import type {
  AuthorDto,
  AuthorListDto,
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

export async function fetchAuthors(): Promise<AuthorListDto> {
  return requestJson<AuthorListDto>(apiUrl("/authors"));
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
