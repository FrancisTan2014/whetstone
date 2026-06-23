import { decomposeMarkdown, type BlockType, type EntryId } from "@whetstone/domain";
import type { IngestMarkdownRequest, WorkContentDto } from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { blocks, entries, entryLinks, readingUnits, workSources } from "../../db/schema.js";
import { loadWorkContent, workExists } from "./contentQueries.js";

// Real infrastructure boundaries (database, id generation, source file store) are
// passed in so ingestion stays deterministic and testable.
export type ContentDependencies = Readonly<{
  createEntryId: () => string;
  createSourceId: () => string;
  db: DbClient;
  sourceFileStore: SourceFileStore;
}>;

export type IngestMarkdownResult =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "work_not_found" }>;

type Provenance = Readonly<{
  fileName: string | null;
  filePath: string | null;
  sha256: string;
  sourceText: string | null;
}>;

export async function ingestMarkdown(
  dependencies: ContentDependencies,
  workEntryId: EntryId,
  source: IngestMarkdownRequest
): Promise<IngestMarkdownResult> {
  if (!(await workExists(dependencies.db, workEntryId))) {
    return { status: "work_not_found" };
  }

  const sourceId = dependencies.createSourceId();
  const provenance = await buildProvenance(dependencies.sourceFileStore, sourceId, source);
  const decomposed = decomposeMarkdown(source.markdown);

  await dependencies.db.transaction(async (tx) => {
    await tx.insert(workSources).values({
      fileName: provenance.fileName,
      filePath: provenance.filePath,
      id: sourceId,
      kind: source.kind,
      sha256: provenance.sha256,
      sourceText: provenance.sourceText,
      workEntryId
    });

    if (decomposed.length === 0) {
      return;
    }

    const existingUnits = await tx
      .select({ entryId: readingUnits.entryId })
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId));
    const startOrder = existingUnits.length;

    const entryRows: { id: string; type: "reading_unit" | "block" }[] = [];
    const readingUnitRows: {
      entryId: string;
      orderIndex: number;
      title: string | null;
      workEntryId: EntryId;
    }[] = [];
    const blockRows: {
      blockType: BlockType;
      entryId: string;
      mdastJson: unknown;
      orderIndex: number;
      plaintext: string;
      readingUnitEntryId: string;
    }[] = [];
    const linkRows: { fromEntryId: string; toEntryId: string; type: "contains" }[] = [];

    decomposed.forEach((unit, unitIndex) => {
      const unitEntryId = dependencies.createEntryId();
      entryRows.push({ id: unitEntryId, type: "reading_unit" });
      readingUnitRows.push({
        entryId: unitEntryId,
        orderIndex: startOrder + unitIndex,
        title: unit.title ?? null,
        workEntryId
      });
      linkRows.push({ fromEntryId: workEntryId, toEntryId: unitEntryId, type: "contains" });

      unit.blocks.forEach((block, blockIndex) => {
        const blockEntryId = dependencies.createEntryId();
        entryRows.push({ id: blockEntryId, type: "block" });
        blockRows.push({
          blockType: block.blockType,
          entryId: blockEntryId,
          mdastJson: block.mdast,
          orderIndex: blockIndex,
          plaintext: block.plaintext,
          readingUnitEntryId: unitEntryId
        });
        linkRows.push({ fromEntryId: unitEntryId, toEntryId: blockEntryId, type: "contains" });
      });
    });

    await tx.insert(entries).values(entryRows);
    await tx.insert(readingUnits).values(readingUnitRows);
    await tx.insert(blocks).values(blockRows);
    await tx.insert(entryLinks).values(linkRows);
  });

  return { content: await loadWorkContent(dependencies.db, workEntryId), status: "ingested" };
}

async function buildProvenance(
  store: SourceFileStore,
  sourceId: string,
  source: IngestMarkdownRequest
): Promise<Provenance> {
  if (source.kind === "manual") {
    return {
      fileName: null,
      filePath: null,
      sha256: store.hashMarkdown(source.markdown),
      sourceText: source.markdown
    };
  }

  const written = await store.writeMarkdownSource({ id: sourceId, markdown: source.markdown });

  return {
    fileName: source.fileName,
    filePath: written.path,
    sha256: written.sha256,
    sourceText: null
  };
}
