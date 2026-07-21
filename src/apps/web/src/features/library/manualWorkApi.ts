import type { ManualWorkDto, UpdateManualWorkContentRequest } from "@whetstone/contracts";
import { parseManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { apiUrl } from "../../shared/runtime";

// The manual-Work editor's API client (#720): every response is parsed through the shared contracts at the
// boundary before the feature trusts it, mirroring the authored/library clients. Unlike the latest-write
// authored save, a save carries the loaded `revision` and can be refused (HTTP 409) when another session
// wrote in between — that outcome is modeled explicitly so the page keeps the learner's local document
// instead of throwing it away.
const jsonHeaders = { "content-type": "application/json" } as const;

// A save either lands (returning the reopened Work with a new revision), is refused because the loaded
// revision is stale (the stored document moved since it was loaded), or is rejected because the document
// is invalid for the schema (defensive: the editor produces valid documents). Each outcome is modeled so
// the page reacts — keeping the learner's local edits — instead of throwing on an expected refusal.
export type SaveManualWorkResult =
  | Readonly<{ status: "saved"; work: ManualWorkDto }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "invalid" }>;

// Load one manual Work with its reassembled canonical document, for the editor to open.
export async function fetchManualWork(workEntryId: string): Promise<ManualWorkDto> {
  const response = await fetch(apiUrl(`/manual-works/${encodeURIComponent(workEntryId)}`));

  if (!response.ok) {
    throw new Error(`Failed to load manual work ${workEntryId} (status ${response.status}).`);
  }

  return parseManualWorkDto(await response.json());
}

// Save a manual Work's canonical document with the revision it was loaded at. A 409 is a revision
// conflict and a 400 is a validation rejection (both surfaced to the page); any other non-2xx is an
// unexpected error and throws.
export async function saveManualWorkContent(
  workEntryId: string,
  document: DocumentNodeJSON,
  revision: string
): Promise<SaveManualWorkResult> {
  const body: UpdateManualWorkContentRequest = { document, revision };
  const response = await fetch(apiUrl(`/manual-works/${encodeURIComponent(workEntryId)}/content`), {
    body: JSON.stringify(body),
    headers: jsonHeaders,
    method: "PUT"
  });

  if (response.status === 409) {
    return { status: "conflict" };
  }

  if (response.status === 400) {
    return { status: "invalid" };
  }

  if (!response.ok) {
    throw new Error(`Failed to save manual work ${workEntryId} (status ${response.status}).`);
  }

  return { status: "saved", work: parseManualWorkDto(await response.json()) };
}
