import type {
  AddManualWorkSectionRequest,
  ManualWorkDto,
  ManualWorkUnitDto,
  UpdateManualWorkContentRequest
} from "@whetstone/contracts";
import { parseManualWorkDto, parseManualWorkUnitDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { apiUrl } from "../../shared/runtime";

// The manual-Work editor's API client (#720/#697): every response is parsed through the shared contracts
// at the boundary before the feature trusts it, mirroring the authored/library clients. Unlike the
// latest-write authored save, a per-section save and an add-section both carry the loaded work-level
// `revision` and can be refused (HTTP 409) when another session wrote in between — that outcome is
// modeled explicitly so the page keeps the learner's local state instead of throwing it away.
const jsonHeaders = { "content-type": "application/json" } as const;

// A save either lands (returning the reopened Work with a new revision and recomputed sections), is
// refused because the loaded revision is stale (the stored document moved since it was loaded), or is
// rejected because the document is invalid for the schema (defensive: the editor produces valid
// documents). Each outcome is modeled so the page reacts — keeping the learner's local edits — instead
// of throwing on an expected refusal.
export type SaveManualWorkResult =
  | Readonly<{ status: "saved"; work: ManualWorkDto }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "invalid" }>;

// Adding a section either lands (returning the Work opened at the NEW section) or is refused because the
// loaded revision is stale. The page keeps its state on a conflict and can reload.
export type AddManualWorkSectionResult =
  | Readonly<{ status: "added"; work: ManualWorkDto }>
  | Readonly<{ status: "conflict" }>;

// Load one manual Work opened at its first section, with that section's reassembled canonical document
// and the ordered section list the Outline is derived from.
export async function fetchManualWork(workEntryId: string): Promise<ManualWorkDto> {
  const response = await fetch(apiUrl(`/manual-works/${encodeURIComponent(workEntryId)}`));

  if (!response.ok) {
    throw new Error(`Failed to load manual work ${workEntryId} (status ${response.status}).`);
  }

  return parseManualWorkDto(await response.json());
}

// Load one section's canonical document on demand, when the learner navigates the Outline to a section
// other than the one the editor opened with.
export async function fetchManualWorkUnit(
  workEntryId: string,
  unitEntryId: string
): Promise<ManualWorkUnitDto> {
  const response = await fetch(
    apiUrl(
      `/manual-works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(unitEntryId)}`
    )
  );

  if (!response.ok) {
    throw new Error(
      `Failed to load section ${unitEntryId} of manual work ${workEntryId} (status ${response.status}).`
    );
  }

  return parseManualWorkUnitDto(await response.json());
}

// Save one section's canonical document with the work-level revision it was loaded at. A 409 is a
// revision conflict and a 400 is a validation rejection (both surfaced to the page); any other non-2xx is
// an unexpected error and throws.
export async function saveManualWorkContent(
  workEntryId: string,
  unitEntryId: string,
  document: DocumentNodeJSON,
  revision: number
): Promise<SaveManualWorkResult> {
  const body: UpdateManualWorkContentRequest = { document, revision };
  const response = await fetch(
    apiUrl(
      `/manual-works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(unitEntryId)}/content`
    ),
    { body: JSON.stringify(body), headers: jsonHeaders, method: "PUT" }
  );

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

// Append a new section (a new reading unit seeded with a heading block) to a manual Work, returning it
// opened at that section. A 409 is a revision conflict; any other non-2xx throws.
export async function addManualWorkSection(
  workEntryId: string,
  revision: number
): Promise<AddManualWorkSectionResult> {
  const body: AddManualWorkSectionRequest = { revision };
  const response = await fetch(apiUrl(`/manual-works/${encodeURIComponent(workEntryId)}/units`), {
    body: JSON.stringify(body),
    headers: jsonHeaders,
    method: "POST"
  });

  if (response.status === 409) {
    return { status: "conflict" };
  }

  if (!response.ok) {
    throw new Error(
      `Failed to add a section to manual work ${workEntryId} (status ${response.status}).`
    );
  }

  return { status: "added", work: parseManualWorkDto(await response.json()) };
}
