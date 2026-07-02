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
  // The unit's source-file identity (EPUB spine href), so the reader can scope a cross-reference by
  // (sourceFile, anchor); absent for a format with no per-unit source file (#366).
  sourceFile?: string;
  title?: string;
}>;

export type WorkContentDto = Readonly<{
  readingUnits: ReadonlyArray<ReadingUnitDto>;
  workEntryId: EntryId;
}>;

// One reading unit in a work's lightweight structure: ordering metadata and the number of
// non-deleted blocks it holds, but no block content. Keeps the structure payload O(units) so a
// lazy-loading reader can render the outline and fetch each unit's blocks on demand. `sourceFile` is
// the unit's source-file identity (EPUB spine href), so the reader can scope a cross-reference from
// the current unit by (sourceFile, anchor); absent for a format with no per-unit source file (#366).
export type ReadingUnitStructureDto = Readonly<{
  blockCount: number;
  entryId: EntryId;
  orderIndex: number;
  sourceFile?: string;
  title?: string;
}>;

// One entry in a work's nav-derived table of contents (#379): an authored nav label plus where it
// points. `depth` and `parentEntryId` capture the authored hierarchy; `orderIndex` is a work-global
// pre-order rank so entries render fully expanded and correctly indented. `targetUnitEntryId` is the
// reading unit the entry opens — resolved server-side from the entry's source-file identity via
// `reading_units.source_file` (#366) — absent for a label-only/structural entry or one whose target
// file has no navigable unit (its selection no-ops). `targetAnchor` is the `#fragment` to scroll to
// within that unit; absent for a whole-file entry (open the unit top).
export const tocEntryDtoSchema = z
  .object({
    depth: z.number().int(),
    entryId: z.string(),
    label: z.string(),
    orderIndex: z.number().int(),
    parentEntryId: z.string().optional(),
    targetAnchor: z.string().optional(),
    targetUnitEntryId: z.string().optional()
  })
  .strict();

export type TocEntryDto = z.infer<typeof tocEntryDtoSchema>;

export type WorkStructureDto = Readonly<{
  readingUnits: ReadonlyArray<ReadingUnitStructureDto>;
  // The work's authored table of contents (#379), served additively alongside the spine-driven
  // reading units. Present only for a work with an authored EPUB nav; absent for Markdown or a
  // nav-less EPUB, where the reader falls back to the flat reading-unit list.
  tableOfContents?: ReadonlyArray<TocEntryDto>;
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
  // The unit's source-file identity (EPUB spine href), so the reader resolves a same-unit marker's
  // cross-reference by (sourceFile, anchor); absent for a format with no per-unit source file (#366).
  sourceFile?: string;
  title?: string;
}>;

// Resolves a block to the reading unit that owns it, so a client that no longer holds every block
// can still open a deep-link (`?block=`) or jump to a note's anchor.
export type BlockUnitLocatorDto = Readonly<{
  unitEntryId: EntryId;
}>;

// One entry in a work's anchor index: an addressable block reachable by its source-HTML `anchor`,
// scoped by the owning unit's `sourceFile` (null for a format with no per-unit source file). The
// (sourceFile, anchor) pair is the key a cross-reference resolves through; `blockEntryId` is the
// target `doc_blocks` id (fed to the reader's block-jump) and `unitEntryId` its owning unit (#366).
export const workAnchorEntryDtoSchema = z
  .object({
    anchor: z.string(),
    blockEntryId: z.string(),
    sourceFile: z.string().nullable(),
    unitEntryId: z.string()
  })
  .strict();

export type WorkAnchorEntryDto = z.infer<typeof workAnchorEntryDtoSchema>;

// A work's anchor index: every addressable block that carries a source-HTML id, so the reader can
// build a work-scoped resolver that jumps cross-unit. The same anchor id reused in two source files
// yields two distinct entries (no collision), because the key is (sourceFile, anchor) (#366).
export const workAnchorIndexDtoSchema = z
  .object({
    anchors: z.array(workAnchorEntryDtoSchema),
    workEntryId: z.string()
  })
  .strict();

export type WorkAnchorIndexDto = z.infer<typeof workAnchorIndexDtoSchema>;

export function parseWorkAnchorIndex(value: unknown): WorkAnchorIndexDto {
  return workAnchorIndexDtoSchema.parse(value);
}

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
