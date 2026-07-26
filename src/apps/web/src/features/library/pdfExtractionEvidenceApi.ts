import type { PdfExtractionEvidenceItemDto } from "@whetstone/contracts";
import { parsePdfExtractionEvidenceDto } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The correction editor's read client for PDF extraction evidence (#763). It fetches the SAFE per-block
// provenance for one eligible imported Work and returns it as a `Map` keyed by block id, the exact shape
// the shared editor's evidence-decoration seam consumes (it decorates a block by its stable node id).
// Every response is parsed through the shared contract at the boundary before the feature trusts it; a
// non-PDF imported Work simply yields an empty map. A 404 (a Work that is not correctable here) is modeled
// as "no evidence" rather than an error, so the correction page degrades to a plain editor.

export type BlockExtractionEvidenceMap = ReadonlyMap<string, PdfExtractionEvidenceItemDto>;

const emptyEvidence: BlockExtractionEvidenceMap = new Map();

// Load all extraction evidence for a correctable imported Work, keyed by block id. Returns an empty map
// for a Work with no evidence (non-PDF import) or one the endpoint declines (404), so a caller can always
// treat the result as a lookup without special-casing absence.
export async function fetchPdfExtractionEvidence(
  workEntryId: string
): Promise<BlockExtractionEvidenceMap> {
  const response = await fetch(
    apiUrl(`/imported-works/${encodeURIComponent(workEntryId)}/extraction-evidence`)
  );

  if (response.status === 404) {
    return emptyEvidence;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to load extraction evidence for imported work ${workEntryId} (status ${response.status}).`
    );
  }

  const dto = parsePdfExtractionEvidenceDto(await response.json());
  return new Map(dto.items.map((item) => [item.blockId, item]));
}
