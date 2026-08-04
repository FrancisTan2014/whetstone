import type { DbClient } from "../../db/dbClient.js";
import { pdfBlockEvidence } from "../../db/schema.js";
import { insertInBatches } from "../content/insertBatching.js";
import type { PdfBlockEvidence } from "./pdfCanonicalMapping.js";

// The additive per-block evidence write for a PDF-derived Work (#702/#745): page geometry, character
// span, confidence, and label per canonical block, plus the attempt's OCR provenance. Shared by
// publication and by the re-map command (#861) — a re-map mints new block ids, and `pdf_block_evidence`
// cascades on the block it describes, so the rebuilt blocks must get their evidence written the same way
// rather than being left with none.
type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// Attempt-level OCR provenance (#745): the engine fingerprint and Tesseract language every block was
// produced under when the attempt adopted a validated OCR stage, or null for a born-digital document that
// never went through OCR. The post-conversion projection carries no per-page OCR flag, so this is
// recorded uniformly for the attempt's blocks rather than per page.
export type PdfOcrProvenance = Readonly<{ engine: string; language: string }>;

export async function writeBlockEvidence(
  tx: Transaction,
  workEntryId: string,
  evidence: readonly PdfBlockEvidence[],
  ocrProvenance: PdfOcrProvenance | null
): Promise<void> {
  const rows = evidence.map((item) => ({
    blockId: item.blockId,
    workEntryId,
    page: item.page,
    left: item.boundingBox.left,
    top: item.boundingBox.top,
    right: item.boundingBox.right,
    bottom: item.boundingBox.bottom,
    charStart: item.charStart,
    charEnd: item.charEnd,
    confidence: item.confidence,
    label: item.label,
    ocrEngine: ocrProvenance?.engine ?? null,
    ocrLanguage: ocrProvenance?.language ?? null
  }));
  await insertInBatches(rows, (batch) => tx.insert(pdfBlockEvidence).values(batch));
}
