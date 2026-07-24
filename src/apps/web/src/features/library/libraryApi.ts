import { epubContentType } from "@whetstone/contracts";
import type {
  AuthorDto,
  AuthorSearchDto,
  CreateAuthorRequest,
  CreateWorkRequest,
  ImportMarkdownWorkRequest,
  IngestEpubResultDto,
  KeepSeparateDecisionRequest,
  OpenExistingDecisionRequest,
  WorkCreationReviewDto,
  WorkListDto,
  WorkListItemDto
} from "@whetstone/contracts";
import { parseWorkCreationReviewDto, parseWorksWithReadingPositionResponse } from "@whetstone/contracts";

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

// The front-door outcome of BEGINNING an imported Markdown Work through the duplicate-review boundary
// (#747). `created` committed a new Work (no credible candidate); `exact_existing` reopened the Work
// that already owns these exact bytes; `needs_review` persisted one owner-scoped attempt and returned
// the review to present before anything is created; `empty_content` refused Markdown with no readable
// blocks; `author_not_found` refused an existing-author selection whose id no longer exists;
// `uncertain` means the candidate query could not be trusted, so nothing was created and the client
// must retry rather than be shown a false "no duplicates".
export type BeginMarkdownCreationOutcome =
  | Readonly<{ result: IngestEpubResultDto; status: "created" | "exact_existing" }>
  | Readonly<{ review: WorkCreationReviewDto; status: "needs_review" }>
  | Readonly<{ status: "empty_content" | "author_not_found" | "uncertain" }>;

// Begin an imported-Markdown Work (#747): the server streams/hashes the upload into a #725 stage,
// reviews exact source and #724 candidates, and either reopens/creates immediately or parks one review
// attempt. Every begin response carries the full outcome object (its `status` plus a `result` or
// `review`), so the client trusts the body's discriminant rather than the HTTP code and never decides
// candidate policy itself.
export async function beginMarkdownCreation(
  request: ImportMarkdownWorkRequest
): Promise<BeginMarkdownCreationOutcome> {
  const path = apiUrl("/works/markdown");
  const response = await fetch(path, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });

  const body = (await response.json()) as { status?: unknown };

  if (body.status === "needs_review") {
    return { review: parseWorkCreationReviewDto((body as { review: unknown }).review), status: "needs_review" };
  }

  if (body.status === "created" || body.status === "exact_existing") {
    return { result: (body as { result: IngestEpubResultDto }).result, status: body.status };
  }

  if (
    body.status === "empty_content" ||
    body.status === "author_not_found" ||
    body.status === "uncertain"
  ) {
    return { status: body.status };
  }

  throw new Error(`Request to ${path} returned an unexpected begin outcome.`);
}

// The current review view for an owner's attempt (#747): `ok` carries the review; the terminal states
// mean the attempt outlived its TTL (`expired`), a recheck could not be trusted (`uncertain`), or no
// such attempt exists for this owner (`not_found`). The panel resolves each terminal state to safe copy
// and never fabricates candidates.
export type WorkCreationReviewLookup =
  | Readonly<{ review: WorkCreationReviewDto; status: "ok" }>
  | Readonly<{ status: "expired" | "uncertain" | "not_found" }>;

export async function fetchWorkCreationReview(attemptId: string): Promise<WorkCreationReviewLookup> {
  const path = apiUrl(`/work-creation-attempts/${encodeURIComponent(attemptId)}`);
  const response = await fetch(path);

  if (response.ok) {
    return { review: parseWorkCreationReviewDto(await response.json()), status: "ok" };
  }

  const body = (await response.json()) as { status?: unknown };

  if (body.status === "expired" || body.status === "uncertain" || body.status === "not_found") {
    return { status: body.status };
  }

  throw new Error(`Request to ${path} failed with status ${response.status}.`);
}

// The outcome of a review DECISION (#747). `opened` reopened the chosen existing Work (changed no
// Work); `created` committed the learner's distinct Work; `exact_existing` means the same bytes were
// meanwhile claimed; `needs_review` refreshed the panel because the candidate evidence changed;
// `existing_gone`/`expired`/`superseded`/`uncertain`/`not_found` are the named non-committing states the
// panel resolves to safe copy.
export type WorkCreationDecisionOutcome =
  | Readonly<{ result: IngestEpubResultDto; status: "opened" | "created" | "exact_existing" }>
  | Readonly<{ review: WorkCreationReviewDto; status: "needs_review" }>
  | Readonly<{ status: "existing_gone" | "expired" | "superseded" | "uncertain" | "not_found" }>;

function decisionOutcome(path: string, body: { status?: unknown }): WorkCreationDecisionOutcome {
  if (body.status === "needs_review") {
    return { review: parseWorkCreationReviewDto((body as { review: unknown }).review), status: "needs_review" };
  }

  if (body.status === "opened" || body.status === "created" || body.status === "exact_existing") {
    return { result: (body as { result: IngestEpubResultDto }).result, status: body.status };
  }

  if (
    body.status === "existing_gone" ||
    body.status === "expired" ||
    body.status === "superseded" ||
    body.status === "uncertain" ||
    body.status === "not_found"
  ) {
    return { status: body.status };
  }

  throw new Error(`Request to ${path} returned an unexpected decision outcome.`);
}

// Open existing: reopen one reviewed candidate Work and consume the attempt (revision-fenced,
// owner-scoped). The server rechecks the chosen Work's existence/ownership and changes no Work.
export async function openExistingWork(
  attemptId: string,
  request: OpenExistingDecisionRequest
): Promise<WorkCreationDecisionOutcome> {
  const path = apiUrl(`/work-creation-attempts/${encodeURIComponent(attemptId)}/open-existing`);
  const response = await fetch(path, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });

  return decisionOutcome(path, (await response.json()) as { status?: unknown });
}

// Keep separate: confirm the proposal is a distinct Work and commit it (revision-fenced). The server
// rechecks exact identity and #724 candidates; changed evidence refreshes the review instead.
export async function keepSeparateWork(
  attemptId: string,
  request: KeepSeparateDecisionRequest
): Promise<WorkCreationDecisionOutcome> {
  const path = apiUrl(`/work-creation-attempts/${encodeURIComponent(attemptId)}/keep-separate`);
  const response = await fetch(path, {
    body: JSON.stringify(request),
    headers: jsonHeaders,
    method: "POST"
  });

  return decisionOutcome(path, (await response.json()) as { status?: unknown });
}

// Back: abandon the review, cancelling the attempt and cleaning its staged bytes. Always resolves so
// dismissing the panel never blocks on a stale attempt.
export async function cancelWorkCreation(attemptId: string): Promise<Readonly<{ cancelled: boolean }>> {
  const path = apiUrl(`/work-creation-attempts/${encodeURIComponent(attemptId)}/cancel`);
  const response = await fetch(path, { method: "POST" });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as { cancelled: boolean };
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
