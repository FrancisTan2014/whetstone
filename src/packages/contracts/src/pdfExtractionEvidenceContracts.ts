import { z } from "zod";

// The read-only extraction-evidence shapes for guiding PDF correction (#763). PDF ingestion (#702)
// retains additive per-block provenance (`pdf_block_evidence`) alongside the canonical `doc_blocks`;
// this endpoint projects the SAFE part of that provenance — never coordinates, never a page image, never
// a file path — so the shared editor can point an administrator at the blocks the extractor was least
// sure about. Every value crossing the boundary is described here and parsed once before the client
// trusts it.

// One canonical block's extraction evidence. `page` is the 1-based source page; `label` is the raw
// converter structure label the block was mapped from; `confidence` is the converter's reported
// confidence or null when it reported none; `ocrEngine`/`ocrLanguage` are present only for a block whose
// page text came from the OCR pass. `reviewSuggested` is the server-computed shared policy (below-
// threshold confidence OR the mapper's unknown/fallback path) and `corrected` is whether the current
// block has already been hand-corrected — the client renders these, never re-deriving the label rules.
export const pdfExtractionEvidenceItemDtoSchema = z
  .object({
    blockId: z.string(),
    confidence: z.number().nullable(),
    corrected: z.boolean(),
    label: z.string(),
    ocrEngine: z.string().nullable(),
    ocrLanguage: z.string().nullable(),
    page: z.number().int(),
    reviewSuggested: z.boolean()
  })
  .strict();

export type PdfExtractionEvidenceItemDto = z.infer<typeof pdfExtractionEvidenceItemDtoSchema>;

// All extraction evidence for one eligible imported Work, keyed by block for the editor to decorate. An
// empty `items` list is the normal answer for a non-PDF imported Work (EPUB/Markdown carry none), so the
// editor simply renders no evidence decoration.
export const pdfExtractionEvidenceDtoSchema = z
  .object({
    items: z.array(pdfExtractionEvidenceItemDtoSchema)
  })
  .strict();

export type PdfExtractionEvidenceDto = z.infer<typeof pdfExtractionEvidenceDtoSchema>;

export function parsePdfExtractionEvidenceDto(value: unknown): PdfExtractionEvidenceDto {
  return pdfExtractionEvidenceDtoSchema.parse(value);
}
