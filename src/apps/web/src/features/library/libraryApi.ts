import { epubContentType } from "@whetstone/contracts";
import type {
  AuthorDto,
  AuthorSearchDto,
  CreateAuthorRequest,
  CreateWorkRequest,
  ImportMarkdownWorkRequest,
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
  const raw = query ?? "";
  const path =
    raw.trim() === "" ? apiUrl("/authors") : apiUrl(`/authors?query=${encodeURIComponent(raw)}`);

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

// The front-door outcome of ingesting an uploaded EPUB (#706): `created` minted a new Work (201),
// `exact_existing` reopened the Work that already owns these exact bytes (200). Both carry the Work so
// the shelf can either announce the import or drop the learner into the already-owning Work.
export type IngestEpubOutcome = Readonly<{
  result: IngestEpubResultDto;
  status: "created" | "exact_existing";
}>;

// Ingest an uploaded EPUB through the shared uploaded-source claim (#706): re-uploading identical bytes
// reopens the existing Work (200) instead of creating a duplicate (201). The status is surfaced so the
// shelf can route a duplicate to the same open-existing behavior as the Markdown front door.
export async function ingestEpub(file: File): Promise<IngestEpubOutcome> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const path = apiUrl("/works/epub");
  const response = await fetch(path, {
    body: bytes,
    headers: { "content-type": epubContentType },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return {
    result: (await response.json()) as IngestEpubResultDto,
    status: response.status === 200 ? "exact_existing" : "created"
  };
}

// The front-door outcome of importing an uploaded .md file (#706): `created` minted a new Work,
// `exact_existing` reopened the Work that already owns these exact bytes, and `empty_content` is the
// server's 422 for Markdown with no readable blocks (so the front door shows an explicit message).
export type ImportMarkdownWorkOutcome =
  | Readonly<{ result: IngestEpubResultDto; status: "created" | "exact_existing" }>
  | Readonly<{ status: "empty_content" }>;

// Mint an imported Work from an uploaded .md file in one request (#706): the Work, its retained source,
// and its single-owner claim are written atomically, so re-uploading identical bytes reopens the
// existing Work (200) instead of creating a duplicate (201).
export async function importMarkdownWork(
  request: ImportMarkdownWorkRequest
): Promise<ImportMarkdownWorkOutcome> {
  const path = apiUrl("/works/markdown");
  const response = await fetch(path, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });

  if (response.status === 422) {
    return { status: "empty_content" };
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return {
    result: (await response.json()) as IngestEpubResultDto,
    status: response.status === 200 ? "exact_existing" : "created"
  };
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
