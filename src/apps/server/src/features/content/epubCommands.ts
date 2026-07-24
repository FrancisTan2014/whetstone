import { toEntryId, type AuthorId } from "@whetstone/domain";
import type { IngestEpubResultDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import { entries, workMeta, workSources } from "../../db/schema.js";
import type { ParsedEpub } from "../../files/epubSource.js";
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

export type ParseEpubResult =
  | Readonly<{ parsed: ParsedEpub; status: "ok" }>
  | Readonly<{ status: "invalid_epub" }>;

// Parse EPUB bytes into normalized metadata + ordered chapters WITHOUT storing any images or writing any
// content, so a caller can weigh duplicate candidates on the embedded metadata (#748) before deciding to
// commit. An upload the parser cannot open is `invalid_epub`, not a crash; the failure is logged (uploads
// carry no filename in v0, so the content hash identifies the failed bytes) so it stays diagnosable.
export async function parseEpubBytes(
  dependencies: ContentDependencies,
  bytes: Uint8Array
): Promise<ParseEpubResult> {
  try {
    return { parsed: await dependencies.epubParser(bytes), status: "ok" };
  } catch (error) {
    console.warn(
      "[ingestion] EPUB could not be parsed",
      JSON.stringify({
        reason: String(error),
        sha256: dependencies.sourceFileStore.hashBytes(bytes)
      })
    );

    return { status: "invalid_epub" };
  }
}

// The input for the shared EPUB commit (#706, #748). Either the caller stages nothing and the commit
// writes the retained `.epub` file itself (the one-step front door / immediate create), or the caller
// supplies a `stagedSource` it already wrote — a review attempt's owned stage (#725) — whose exact bytes
// are transferred to provenance in place rather than re-written. `bytes`/`parsed` are the already-parsed
// upload, so images/blocks/nav are resolved once here regardless.
export type CommitImportedEpubInput = Readonly<{
  bytes: Uint8Array;
  parsed: ParsedEpub;
  // A pre-written stage this commit transfers to provenance instead of writing a new source file. When
  // absent, the commit writes the `.epub` file itself. `path` is the retained source's relative path.
  stagedSource?: Readonly<{ path: string }>;
}>;

// Mint an imported Work from parsed EPUB bytes through the shared uploaded-source claim boundary (#706):
// figure images are stored (content-addressed) up front so each figure block carries its resolved
// imageResourceId, then the Work, its retained source, its ReadingUnits/blocks, its authored nav (#379),
// and its single-owner claim are written in one transaction. A concurrent loser rolls the whole creation
// back and reopens the winner. When a `stagedSource` is supplied (the reviewed-creation flow, #748), its
// already-written bytes become the provenance file in place — the staged upload is transferred, never
// re-written or double-owned; an abandoned review that never commits leaves no images, author, or file.
export async function commitImportedEpubWork(
  dependencies: ContentDependencies,
  input: CommitImportedEpubInput
): Promise<Readonly<{ result: IngestEpubResultDto; status: "created" | "exact_existing" }>> {
  const { bytes, parsed } = input;
  const sourceId = dependencies.createSourceId();
  const sha256 = dependencies.sourceFileStore.hashBytes(bytes);

  // Figure images are stored (content-addressed) up front so each figure block can be stamped with its
  // resolved imageResourceId before the content is written. The clean-plugin pipeline (#275) then trims
  // publisher boilerplate units before they reach block-write.
  const resolved = await resolveChapters(parsed.chapters, dependencies.imageResourceStore);
  const units = applyContentFilters(resolved, defaultContentFilters);

  // Fail-loud (#311): surface every unrecognized block-level element from the surviving units to the
  // injected sink, so a publisher construct the schema could not model is recorded, not dropped
  // silently. Called unconditionally (an empty batch is a no-op) so the path runs in the real flow.
  dependencies.ingestionLogger(units.flatMap((unit) => unit.evidence));

  const expectedBlockCount = units.reduce((total, unit) => total + unit.blocks.length, 0);

  const outcome = await claimUploadedSource(dependencies.db, {
    sha256,
    // Reuse the caller's already-written stage in place when transferring a review attempt's upload
    // (#748); otherwise write the retained `.epub` source now. Either way `commit` points the source row
    // at `written.path`, so provenance is a single owned file.
    stage: () =>
      input.stagedSource === undefined
        ? dependencies.sourceFileStore.writeEpubSource({ bytes, id: sourceId })
        : Promise.resolve({ path: input.stagedSource.path, sha256 }),
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

// EPUB uploads create a Work in one step: the OPF supplies title/author/language and the spine supplies
// ordered chapters, each decomposed into a reading unit of blocks. Re-uploading identical bytes (same
// sha256) reopens the existing Work through the shared uploaded-source claim boundary (#706) instead of
// creating a duplicate. This one-step front door is retained for the immediate-create path and adapter
// tests; imported-EPUB Work creation is otherwise routed through the duplicate-review boundary (#748).
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

  const parsed = await parseEpubBytes(dependencies, bytes);

  if (parsed.status === "invalid_epub") {
    return { status: "invalid_epub" };
  }

  return commitImportedEpubWork(dependencies, { bytes, parsed: parsed.parsed });
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
