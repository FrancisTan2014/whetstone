import type { BlockType, EntryId } from "@whetstone/domain";
import { z } from "zod";

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
