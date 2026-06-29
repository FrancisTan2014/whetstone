import type { BlockType, EntryId } from "@whetstone/domain";
import { z } from "zod";

import type { WorkDto } from "./libraryContracts.js";

function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

function isMarkdownFileName(value: string): boolean {
  return /\.md$/i.test(value.trim());
}

const manualMarkdownSourceSchema = z
  .object({
    kind: z.literal("manual"),
    markdown: z.string().refine(isNonBlank, { message: "markdown must be non-empty." })
  })
  .strict();

const uploadMarkdownSourceSchema = z
  .object({
    fileName: z
      .string()
      .refine(isNonBlank, { message: "fileName must be non-empty." })
      .refine(isMarkdownFileName, { message: "fileName must end with .md." }),
    kind: z.literal("upload"),
    markdown: z.string().refine(isNonBlank, { message: "markdown must be non-empty." })
  })
  .strict();

// Ingestion accepts manual Markdown input or an uploaded .md file's contents; the
// owning work is identified by the route, not the body.
export const ingestMarkdownRequestSchema = z.discriminatedUnion("kind", [
  manualMarkdownSourceSchema,
  uploadMarkdownSourceSchema
]);

export type IngestMarkdownRequest = z.infer<typeof ingestMarkdownRequestSchema>;

export function parseIngestMarkdownRequest(value: unknown): IngestMarkdownRequest {
  return ingestMarkdownRequestSchema.parse(value);
}

// A figure block additionally carries the shared image it renders (`imageResourceId`)
// and its `alt` text; both are optional and absent on non-figure blocks. The caption
// continues to travel as the block's `mdast` + `plaintext`.
export type BlockDto = Readonly<{
  alt?: string;
  blockType: BlockType;
  entryId: EntryId;
  imageResourceId?: string;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
}>;

export type ReadingUnitDto = Readonly<{
  blocks: ReadonlyArray<BlockDto>;
  entryId: EntryId;
  orderIndex: number;
  title?: string;
}>;

export type WorkContentDto = Readonly<{
  readingUnits: ReadonlyArray<ReadingUnitDto>;
  workEntryId: EntryId;
}>;

// One reading unit in a work's lightweight structure: ordering metadata and the number of
// non-deleted blocks it holds, but no block content. Keeps the structure payload O(units) so a
// lazy-loading reader can render the outline and fetch each unit's blocks on demand.
export type ReadingUnitStructureDto = Readonly<{
  blockCount: number;
  entryId: EntryId;
  orderIndex: number;
  title?: string;
}>;

export type WorkStructureDto = Readonly<{
  readingUnits: ReadonlyArray<ReadingUnitStructureDto>;
  workEntryId: EntryId;
}>;

// One reading unit's content, fetched on demand: the unit's ordering metadata plus its ordered,
// non-deleted blocks.
export type ReadingUnitContentDto = Readonly<{
  blocks: ReadonlyArray<BlockDto>;
  entryId: EntryId;
  orderIndex: number;
  title?: string;
}>;

// Resolves a block to the reading unit that owns it, so a client that no longer holds every block
// can still open a deep-link (`?block=`) or jump to a note's anchor.
export type BlockUnitLocatorDto = Readonly<{
  unitEntryId: EntryId;
}>;

// EPUB uploads are sent as the raw file bytes under this media type; the owning work
// is created from the EPUB's own OPF metadata, so there is no JSON request body.
export const epubContentType = "application/epub+zip";

// PDF uploads are sent as raw bytes under this media type; a Python doc-AI worker converts the PDF to
// Markdown, which then flows through the same Markdown -> blocks pipeline (#15). No PDF block model.
export const pdfContentType = "application/pdf";

// Ingesting an EPUB creates a Work and its content in one step, so the result returns
// both the created/matched work and its decomposed content.
export type IngestEpubResultDto = Readonly<{
  content: WorkContentDto;
  work: WorkDto;
}>;
