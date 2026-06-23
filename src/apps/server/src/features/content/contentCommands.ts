import { decomposeMarkdown, type EntryId } from "@whetstone/domain";
import type { IngestMarkdownRequest, WorkContentDto } from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import type { EpubParser } from "../../files/epubSource.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { readingUnits, workSources } from "../../db/schema.js";
import { writeReadingUnits } from "./blockWriter.js";
import { loadWorkContent, workExists } from "./contentQueries.js";

// Real infrastructure boundaries (database, id generation, source file store, EPUB
// parser) are passed in so ingestion stays deterministic and testable.
export type ContentDependencies = Readonly<{
  createAuthorId: () => string;
  createEntryId: () => string;
  createSourceId: () => string;
  db: DbClient;
  epubParser: EpubParser;
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

    const existingUnits = await tx
      .select({ entryId: readingUnits.entryId })
      .from(readingUnits)
      .where(eq(readingUnits.workEntryId, workEntryId));

    await writeReadingUnits(tx, {
      createEntryId: dependencies.createEntryId,
      startOrder: existingUnits.length,
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
