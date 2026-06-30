import { toAuthorId, toEntryId, type AuthorId } from "@whetstone/domain";
import type { IngestEpubResultDto, WorkDto } from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { authors, entries, workMeta, workSources } from "../../db/schema.js";
import { writeReadingUnits } from "./blockWriter.js";
import type { ContentDependencies } from "./contentCommands.js";
import { applyContentFilters, defaultContentFilters } from "./contentFilters.js";
import { resolveChapters } from "./figureImageResolver.js";
import { assertContentPersisted } from "./insertBatching.js";
import { loadWorkContent } from "./contentQueries.js";

export type IngestEpubResult =
  | Readonly<{ result: IngestEpubResultDto; status: "duplicate" }>
  | Readonly<{ result: IngestEpubResultDto; status: "ingested" }>
  | Readonly<{ status: "invalid_epub" }>;

// EPUB uploads create a Work in one step: the OPF supplies title/author/language and
// the spine supplies ordered chapters, each decomposed into a reading unit of blocks.
// Re-uploading identical bytes (same sha256) is a no-op that returns the existing work.
export async function ingestEpub(
  dependencies: ContentDependencies,
  bytes: Uint8Array
): Promise<IngestEpubResult> {
  const sha256 = dependencies.sourceFileStore.hashBytes(bytes);

  const existing = await findWorkBySha256(dependencies.db, sha256);

  if (existing !== undefined) {
    return { result: existing, status: "duplicate" };
  }

  let parsed;

  try {
    parsed = await dependencies.epubParser(bytes);
  } catch {
    return { status: "invalid_epub" };
  }

  const sourceId = dependencies.createSourceId();
  const written = await dependencies.sourceFileStore.writeEpubSource({ bytes, id: sourceId });
  // Figure images are stored (content-addressed) up front so each figure block can be
  // stamped with its resolved imageResourceId before the content is written. The clean-plugin
  // pipeline (#275) then trims publisher boilerplate units before they reach block-write.
  const resolved = await resolveChapters(parsed.chapters, dependencies.imageResourceStore);
  const units = applyContentFilters(resolved, defaultContentFilters);

  // Fail-loud (#311): surface every unrecognized block-level element from the surviving units to the
  // injected sink, so a publisher construct the schema could not model is recorded, not dropped
  // silently. Called unconditionally (an empty batch is a no-op) so the path runs in the real flow.
  dependencies.ingestionLogger(units.flatMap((unit) => unit.evidence));

  const workEntryId = toEntryId(dependencies.createEntryId());
  const authorId = await dependencies.db.transaction(async (tx) => {
    const resolvedAuthorId = await resolveAuthorByName(tx, dependencies, parsed.metadata.author);
    await tx.insert(entries).values({ id: workEntryId, type: "work" });
    await tx.insert(workMeta).values({
      authorId: resolvedAuthorId,
      entryId: workEntryId,
      language: parsed.metadata.language,
      title: parsed.metadata.title,
      workType: "book"
    });
    await tx.insert(workSources).values({
      fileName: null,
      filePath: written.path,
      id: sourceId,
      kind: "upload",
      sha256: written.sha256,
      sourceText: null,
      workEntryId
    });
    await writeReadingUnits(tx, {
      createEntryId: dependencies.createEntryId,
      startOrder: 0,
      units,
      workEntryId
    });

    return resolvedAuthorId;
  });

  const work: WorkDto = {
    authorId,
    entryId: workEntryId,
    language: parsed.metadata.language,
    title: parsed.metadata.title,
    workType: "book"
  };

  const expectedBlockCount = units.reduce((total, unit) => total + unit.blocks.length, 0);
  const content = assertContentPersisted(
    expectedBlockCount,
    await loadWorkContent(dependencies.db, workEntryId)
  );

  return {
    result: { content, work },
    status: "ingested"
  };
}

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

async function resolveAuthorByName(
  tx: Transaction,
  dependencies: ContentDependencies,
  name: string
): Promise<AuthorId> {
  const existing = await tx.select().from(authors).where(eq(authors.name, name)).limit(1);
  const found = existing[0];

  if (found !== undefined) {
    return toAuthorId(found.id);
  }

  const id = toAuthorId(dependencies.createAuthorId());
  await tx.insert(authors).values({ id, name });

  return id;
}

async function findWorkBySha256(
  db: DbClient,
  sha256: string
): Promise<IngestEpubResultDto | undefined> {
  const rows = await db
    .select({
      authorId: workMeta.authorId,
      entryId: workMeta.entryId,
      language: workMeta.language,
      title: workMeta.title,
      workType: workMeta.workType
    })
    .from(workSources)
    .innerJoin(workMeta, eq(workMeta.entryId, workSources.workEntryId))
    .where(eq(workSources.sha256, sha256))
    .limit(1);
  const row = rows[0];

  if (row === undefined) {
    return undefined;
  }

  const workEntryId = toEntryId(row.entryId);
  const work: WorkDto = {
    authorId: toAuthorId(row.authorId),
    entryId: workEntryId,
    language: row.language,
    title: row.title,
    workType: row.workType
  };

  return { content: await loadWorkContent(db, workEntryId), work };
}
