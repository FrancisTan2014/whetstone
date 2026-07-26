// The one pure "needs review" policy for PDF extraction evidence (#763). PDF ingestion (#702) publishes
// each block's canonical content into `doc_blocks` and, additively, the converter confidence and raw
// label into `pdf_block_evidence`. That evidence GUIDES correction but never becomes content: an
// administrator finds the blocks the extractor was least sure about, without a PDF-specific editor.
//
// This module is the single source of truth for that judgement, shared by the PDF publication tests
// (which reason over the mapper's decision) and the editor evidence query (which reads it back). The web
// client never re-derives it — it renders the boolean and the confidence band this module computes, so a
// second label list is never duplicated across the boundary. Pure and dependency-free: it tests without
// React, Fastify, PostgreSQL, or fs.

// A block is suggested for review when its extraction confidence is below this threshold. A confidence
// AT or above it reads as "High"; a null confidence is "Not reported" and is never itself a suggestion.
export const PDF_EXTRACTION_CONFIDENCE_THRESHOLD = 0.75;

// The canonical node type the mapper (#702) assigns to a construct it has NO canonical representation for
// (an unrecognized label, or an empty table/list that fell back). A block of this type took the mapper's
// unknown/fallback path, so it is a correction candidate regardless of the reported confidence.
export const UNMAPPED_BLOCK_TYPE = "unknown";

// How a block's reported confidence reads to a human. Never a raw percentage masquerading as certainty:
// "review-suggested" is the actionable band, "high" is calm, and a block whose extractor reported no
// confidence at all is "not-reported" rather than pretending to a number.
export type ExtractionConfidenceBand = "high" | "not-reported" | "review-suggested";

// Classify a block's reported extraction confidence into its human band. A null confidence (the extractor
// reported none) is "not-reported"; `>= threshold` is "high"; anything below the threshold is
// "review-suggested".
export function classifyExtractionConfidence(confidence: number | null): ExtractionConfidenceBand {
  if (confidence === null) {
    return "not-reported";
  }

  return confidence >= PDF_EXTRACTION_CONFIDENCE_THRESHOLD ? "high" : "review-suggested";
}

// Whether a block took the mapper's unknown/fallback path, decided from the canonical node type the
// mapper persisted (`doc_blocks.type`) rather than a re-listed label set. This is the SAME mapping
// decision the publication made, read back — no second catalog of "known" labels lives anywhere else.
export function isUnmappedBlockType(blockType: string): boolean {
  return blockType === UNMAPPED_BLOCK_TYPE;
}

// The policy. A block is suggested for review when its extraction confidence is below the threshold OR it
// took the mapper's unknown/fallback path. Both inputs are facts the publication persisted (the evidence
// row's confidence, the block's canonical node type), so the query and the publication tests reach the
// same verdict from the same data.
export function suggestsExtractionReview(
  input: Readonly<{ confidence: number | null; unmapped: boolean }>
): boolean {
  return input.unmapped || classifyExtractionConfidence(input.confidence) === "review-suggested";
}
