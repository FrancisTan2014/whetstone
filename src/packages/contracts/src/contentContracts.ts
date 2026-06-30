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
  anchorId?: string;
  // A footnote/endnote block's back-link to its marker (noteref) anchor id, so the reader renders a
  // jump-back affordance (#250). Absent on ordinary blocks.
  backlinkAnchorId?: string;
  blockType: BlockType;
  entryId: EntryId;
  imageResourceId?: string;
  mdast: unknown;
  orderIndex: number;
  plaintext: string;
}>;

// One reading unit's ProseMirror/Tiptap block (#311): the persisted document node the read-only
// reader renders directly via `@tiptap/static-renderer` (#312), replacing the mdast render path.
// `entryId` is the block's stable PM node id (its `data-block-id` in the reader); `node` is the
// persisted node JSON (a figure/image node carries `imageResourceId` for the stored EPUB image);
// blocks travel in `orderIndex` order. Additive to the mdast `blocks`, which search still consumes.
export type DocBlockDto = Readonly<{
  entryId: EntryId;
  node: unknown;
  orderIndex: number;
  type: string;
}>;

export type ReadingUnitDto = Readonly<{
  blocks: ReadonlyArray<BlockDto>;
  // The unit's PM `doc_blocks` (#311): populated for an EPUB unit, empty for a Markdown unit. Optional
  // so the field stays additive — pre-#312 payloads and test fixtures may omit it (read as empty).
  docBlocks?: ReadonlyArray<DocBlockDto>;
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
// non-deleted blocks — both the mdast `blocks` (search/legacy) and the PM `docBlocks` the reader renders.
export type ReadingUnitContentDto = Readonly<{
  blocks: ReadonlyArray<BlockDto>;
  // The unit's PM `doc_blocks` (#311): populated for an EPUB unit, empty for a Markdown unit (see
  // `ReadingUnitDto.docBlocks`). The reader renders these when non-empty, else falls back to mdast.
  docBlocks?: ReadonlyArray<DocBlockDto>;
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
