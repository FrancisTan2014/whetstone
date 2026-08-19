import type {
  AddImportedWorkSectionRequest,
  CorrectImportedWorkContentRequest,
  ImportedWorkDto,
  ImportedWorkUnitDto,
  WorkSectionPlacement
} from "@whetstone/contracts";
import { parseImportedWorkDto, parseImportedWorkUnitDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { apiUrl } from "../../shared/runtime";

// The imported-Work correction editor's API client (#762): the administrative counterpart to
// `manualWorkApi`. It drives the SAME shared editor against the imported-correction endpoints
// (`/api/imported-works/...`), parsing every response through the shared contracts at the boundary before
// the feature trusts it. Like the manual client, a per-section save and an add-section both carry the
// loaded work-level `revision` and can be refused (HTTP 409) when another session wrote in between — that
// outcome is modeled explicitly so the page keeps the administrator's local state instead of throwing it
// away. Unlike the manual client, the DTO carries no owner chronology and adds `correctedAt`, and the
// endpoints authorize an administrator rather than the owner.
const jsonHeaders = { "content-type": "application/json" } as const;

// A correction save either lands (returning the reopened Work with a new revision and recomputed
// sections), is refused because the loaded revision is stale, or is rejected because the document is
// invalid for the schema. Each outcome is modeled so the page keeps the administrator's edits.
export type SaveImportedWorkResult =
  | Readonly<{ status: "saved"; work: ImportedWorkDto }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "invalid" }>;

// Adding a section either lands (returning the Work opened at the NEW section) or is refused because the
// loaded revision is stale. The page keeps its state on a conflict and can reload.
export type AddImportedWorkSectionResult =
  | Readonly<{ status: "added"; work: ImportedWorkDto }>
  | Readonly<{ status: "conflict" }>;

// Load one imported Work opened at its first section for correction, with that section's reassembled
// canonical document and the ordered section list the Outline is derived from.
export async function fetchImportedWork(workEntryId: string): Promise<ImportedWorkDto> {
  const response = await fetch(apiUrl(`/imported-works/${encodeURIComponent(workEntryId)}`));

  if (!response.ok) {
    throw new Error(`Failed to load imported work ${workEntryId} (status ${response.status}).`);
  }

  return parseImportedWorkDto(await response.json());
}

// Load one section's canonical document on demand, when the administrator navigates the Outline to a
// section other than the one the editor opened with.
export async function fetchImportedWorkUnit(
  workEntryId: string,
  unitEntryId: string
): Promise<ImportedWorkUnitDto> {
  const response = await fetch(
    apiUrl(
      `/imported-works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(unitEntryId)}`
    )
  );

  if (!response.ok) {
    throw new Error(
      `Failed to load section ${unitEntryId} of imported work ${workEntryId} (status ${response.status}).`
    );
  }

  return parseImportedWorkUnitDto(await response.json());
}

// Save one section's corrected canonical document with the work-level revision it was loaded at. A 409 is
// a revision conflict and a 400 is a validation rejection (both surfaced to the page); any other non-2xx
// is an unexpected error and throws.
export async function saveImportedWorkContent(
  workEntryId: string,
  unitEntryId: string,
  document: DocumentNodeJSON,
  revision: number
): Promise<SaveImportedWorkResult> {
  const body: CorrectImportedWorkContentRequest = { document, revision };
  const response = await fetch(
    apiUrl(
      `/imported-works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(unitEntryId)}/content`
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
    throw new Error(`Failed to save imported work ${workEntryId} (status ${response.status}).`);
  }

  return { status: "saved", work: parseImportedWorkDto(await response.json()) };
}

// Insert a contextual section under the canonical target of an imported Work under correction, returning
// it opened at that section. A 409 is a revision conflict; any other non-2xx throws.
export async function addImportedWorkSection(
  workEntryId: string,
  targetUnitEntryId: string,
  placement: WorkSectionPlacement,
  revision: number
): Promise<AddImportedWorkSectionResult> {
  const body: AddImportedWorkSectionRequest = { placement, revision, targetUnitEntryId };
  const response = await fetch(apiUrl(`/imported-works/${encodeURIComponent(workEntryId)}/units`), {
    body: JSON.stringify(body),
    headers: jsonHeaders,
    method: "POST"
  });

  if (response.status === 409) {
    return { status: "conflict" };
  }

  if (!response.ok) {
    throw new Error(
      `Failed to add a section to imported work ${workEntryId} (status ${response.status}).`
    );
  }

  return { status: "added", work: parseImportedWorkDto(await response.json()) };
}
