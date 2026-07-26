import { isUnmappedBlockType, suggestsExtractionReview, type EntryId } from "@whetstone/domain";
import type { PdfExtractionEvidenceDto, PdfExtractionEvidenceItemDto } from "@whetstone/contracts";
import { asc, eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { docBlocks, pdfBlockEvidence } from "../../db/schema.js";
import { findCorrectableImportedWork } from "./importedWorkContentQueries.js";

// The read side of PDF-correction guidance (#763): return the SAFE extraction evidence for one eligible
// imported Work so the shared editor can point an administrator at the blocks the extractor was least sure
// about. It reuses the #762 correctable-imported-Work gate for authorization/eligibility (a manual,
// authored, unknown, or non-canonical Work returns `undefined` -> 404), then reads the additive
// `pdf_block_evidence` rows joined to their live `doc_blocks`. Nothing coordinate-, image-, or path-shaped
// crosses the boundary — only page, raw label, confidence, OCR provenance, the derived review suggestion,
// and whether the block has been corrected.
//
// Cross-Work isolation is structural: the query is scoped by `pdf_block_evidence.work_entry_id` and the
// endpoint accepts no client-supplied block id, so no block outside the requested Work is ever exposed.
// A non-PDF imported Work (EPUB/Markdown) simply has no evidence rows and yields an empty list.

// The review suggestion is derived from the SAME mapping decision the publication made, read back: the
// block's persisted canonical `type` (`unknown` == the mapper's fallback path) and the evidence row's
// confidence, both fed through the shared `@whetstone/domain` policy. The confidence band the client shows
// (High / Review suggested / Not reported) is likewise derived there, so no second label list is duplicated.
function toEvidenceItem(row: {
  blockId: string;
  blockType: string;
  confidence: number | null;
  correctedAt: Date | null;
  label: string;
  ocrEngine: string | null;
  ocrLanguage: string | null;
  page: number;
}): PdfExtractionEvidenceItemDto {
  return {
    blockId: row.blockId,
    confidence: row.confidence,
    corrected: row.correctedAt !== null,
    label: row.label,
    ocrEngine: row.ocrEngine,
    ocrLanguage: row.ocrLanguage,
    page: row.page,
    reviewSuggested: suggestsExtractionReview({
      confidence: row.confidence,
      unmapped: isUnmappedBlockType(row.blockType)
    })
  };
}

// Load all extraction evidence for a correctable imported Work, or `undefined` when the Work is not an
// eligible imported Work (so the route answers 404 exactly as the correction endpoints do). Ordered by
// source page then block id for a deterministic response; the editor keys it by block id regardless.
export async function loadPdfExtractionEvidence(
  db: DbClient,
  workEntryId: EntryId
): Promise<PdfExtractionEvidenceDto | undefined> {
  const work = await findCorrectableImportedWork(db, workEntryId);

  if (work === undefined) {
    return undefined;
  }

  const rows = await db
    .select({
      blockId: pdfBlockEvidence.blockId,
      blockType: docBlocks.type,
      confidence: pdfBlockEvidence.confidence,
      correctedAt: docBlocks.correctedAt,
      label: pdfBlockEvidence.label,
      ocrEngine: pdfBlockEvidence.ocrEngine,
      ocrLanguage: pdfBlockEvidence.ocrLanguage,
      page: pdfBlockEvidence.page
    })
    .from(pdfBlockEvidence)
    .innerJoin(docBlocks, eq(docBlocks.id, pdfBlockEvidence.blockId))
    .where(eq(pdfBlockEvidence.workEntryId, workEntryId))
    .orderBy(asc(pdfBlockEvidence.page), asc(pdfBlockEvidence.blockId));

  return { items: rows.map((row) => toEvidenceItem(row)) };
}
