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

export type BlockDto = Readonly<{
  blockType: BlockType;
  entryId: EntryId;
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

// EPUB uploads are sent as the raw file bytes under this media type; the owning work
// is created from the EPUB's own OPF metadata, so there is no JSON request body.
export const epubContentType = "application/epub+zip";

// Ingesting an EPUB creates a Work and its content in one step, so the result returns
// both the created/matched work and its decomposed content.
export type IngestEpubResultDto = Readonly<{
  content: WorkContentDto;
  work: WorkDto;
}>;
