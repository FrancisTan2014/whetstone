import { toEntryId, type AuthorId } from "@whetstone/domain";
import type { IngestEpubResultDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import { entries, workMeta, workSources } from "../../db/schema.js";
import { parseNavDocument } from "../../files/epubNav.js";
import { resolveNamedAuthor } from "../library/authorResolver.js";
import { writeReadingUnits } from "./blockWriter.js";
import type { ContentDependencies } from "./contentCommands.js";
import { applyContentFilters, defaultContentFilters } from "./contentFilters.js";
import { resolveChapters } from "./figureImageResolver.js";
import { claimUploadedSource, findClaimedWork } from "./sourceClaims.js";
import { writeTocEntries } from "./tocWriter.js";

export type IngestEpubResult =
  | Readonly<{ result: IngestEpubResultDto; status: "exact_existing" }>
  | Readonly<{ result: IngestEpubResultDto; status: "created" }>
  | Readonly<{ status: "invalid_epub" }>;

// EPUB uploads create a Work in one step: the OPF supplies title/author/language and
// the spine supplies ordered chapters, each decomposed into a reading unit of blocks.
// Re-uploading identical bytes (same sha256) reopens the existing Work through the shared
// uploaded-source claim boundary (#706) instead of creating a duplicate.
export async function ingestEpub(
  dependencies: ContentDependencies,
  bytes: Uint8Array
): Promise<IngestEpubResult> {
  const sha256 = dependencies.sourceFileStore.hashBytes(bytes);

  // Reopen an already-claimed upload before doing any parse/image work: identical bytes resolve to
  // the one owning Work regardless of the format.
  const claimed = await findClaimedWork(dependencies.db, sha256);

  if (claimed !== undefined) {
    return { result: { content: claimed.content, work: claimed.work }, status: "exact_existing" };
  }

  let parsed;

  try {
    parsed = await dependencies.epubParser(bytes);
  } catch (error) {
    // Don't fail silently: a valid-looking upload the parser could not open is worth a log line so
    // the failure is diagnosable (the sweep in #359 only found its two crashers because it captured
    // the stack). Uploads carry no filename in v0, so the content hash identifies the failed bytes.
    console.warn(
      "[ingestion] EPUB could not be parsed",
      JSON.stringify({ reason: String(error), sha256 })
    );

    return { status: "invalid_epub" };
  }

  const sourceId = dependencies.createSourceId();
  // Figure images are stored (content-addressed) up front so each figure block can be
  // stamped with its resolved imageResourceId before the content is written. The clean-plugin
  // pipeline (#275) then trims publisher boilerplate units before they reach block-write.
  const resolved = await resolveChapters(parsed.chapters, dependencies.imageResourceStore);
  const units = applyContentFilters(resolved, defaultContentFilters);

  // Fail-loud (#311): surface every unrecognized block-level element from the surviving units to the
  // injected sink, so a publisher construct the schema could not model is recorded, not dropped
  // silently. Called unconditionally (an empty batch is a no-op) so the path runs in the real flow.
  dependencies.ingestionLogger(units.flatMap((unit) => unit.evidence));

  const expectedBlockCount = units.reduce((total, unit) => total + unit.blocks.length, 0);

  const outcome = await claimUploadedSource(dependencies.db, {
    sha256,
    stage: () => dependencies.sourceFileStore.writeEpubSource({ bytes, id: sourceId }),
    releaseStage: (written) => dependencies.sourceFileStore.deleteSourceFile(written.path),
    commit: async (tx, written) => {
      const workEntryId = toEntryId(dependencies.createEntryId());
      const authorId = await resolveAuthorByName(tx, dependencies, parsed.metadata.author);
      await tx.insert(entries).values({ id: workEntryId, type: "work" });
      await tx.insert(workMeta).values({
        authorId,
        entryId: workEntryId,
        language: parsed.metadata.language,
        origin: "imported",
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

      // Persist the EPUB's authored nav tree (#379), after units exist so its entries can later be
      // matched to reading units by `source_file` at serve time. Fail-soft: no nav — or an
      // unparseable/empty one — persists no toc_entries and never fails the ingest.
      if (parsed.nav !== undefined) {
        await writeTocEntries(tx, {
          createEntryId: dependencies.createEntryId,
          navEntries: parseNavDocument(parsed.nav.source, parsed.nav.kind),
          navPath: parsed.nav.path,
          workEntryId
        });
      }

      return {
        expectedBlockCount,
        work: {
          authorId,
          entryId: workEntryId,
          language: parsed.metadata.language,
          origin: "imported",
          title: parsed.metadata.title,
          workType: "book"
        },
        workEntryId
      };
    }
  });

  return { result: { content: outcome.content, work: outcome.work }, status: outcome.status };
}

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

async function resolveAuthorByName(
  tx: Transaction,
  dependencies: ContentDependencies,
  name: string
): Promise<AuthorId> {
  const resolved = await resolveNamedAuthor(tx, dependencies.createAuthorId, name);

  return resolved.author.id;
}
