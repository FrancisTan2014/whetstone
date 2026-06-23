import { blocksToMarkdown, decomposeMarkdown, diffBlocks, type EntryId } from "@whetstone/domain";
import type { IngestMarkdownRequest, WorkContentDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import type { EpubParser } from "../../files/epubSource.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { workSources } from "../../db/schema.js";
import { reconcileWorkBlocks } from "./blockReconciler.js";
import { loadWorkContent, workExists, workHasSource } from "./contentQueries.js";

// Real infrastructure boundaries (database, id generation, source file store, EPUB
// parser) are passed in so ingestion stays deterministic and testable.
export type ContentDependencies = Readonly<{
  createAuthorId: () => string;
  createEntryId: () => string;
  createSourceId: () => string;
  db: DbClient;
  epubParser: EpubParser;
  epubUploadLimitBytes: number;
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

// Ingesting Markdown replaces the work's content: a content-similarity diff preserves
// stable block ids for matched/lightly-edited blocks (so note anchors stay valid),
// assigns new ids to genuinely new blocks, and soft-deletes removed ones. Re-ingesting
// an identical source is a no-op. The whole replacement runs in one transaction.
export async function ingestMarkdown(
  dependencies: ContentDependencies,
  workEntryId: EntryId,
  source: IngestMarkdownRequest
): Promise<IngestMarkdownResult> {
  if (!(await workExists(dependencies.db, workEntryId))) {
    return { status: "work_not_found" };
  }

  const decomposed = decomposeMarkdown(source.markdown);
  const current = await loadWorkContent(dependencies.db, workEntryId);

  const currentNodes = current.readingUnits.flatMap((unit) =>
    unit.blocks.map((block) => block.mdast)
  );
  const newNodes = decomposed.flatMap((unit) => unit.blocks.map((block) => block.mdast));

  if (
    (await workHasSource(dependencies.db, workEntryId)) &&
    blocksToMarkdown(currentNodes) === blocksToMarkdown(newNodes)
  ) {
    return { content: current, status: "ingested" };
  }

  const sourceId = dependencies.createSourceId();
  const provenance = await buildProvenance(dependencies.sourceFileStore, sourceId, source);

  const oldBlocks = current.readingUnits.flatMap((unit) =>
    unit.blocks.map((block) => ({ id: block.entryId, plaintext: block.plaintext }))
  );
  const newBlocks = decomposed.flatMap((unit) => unit.blocks);
  const diff = diffBlocks(
    oldBlocks,
    newBlocks.map((block) => ({ plaintext: block.plaintext }))
  );
  const oldUnitIds = current.readingUnits.map((unit) => unit.entryId);

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

    await reconcileWorkBlocks(tx, {
      assignments: diff.assignments,
      createEntryId: dependencies.createEntryId,
      oldUnitIds,
      removedIds: diff.removedIds,
      units: decomposed,
      workEntryId
    });
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
