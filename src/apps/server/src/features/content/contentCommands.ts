import {
  blocksToMarkdown,
  decomposeMarkdown,
  diffBlocks,
  toEntryId,
  type AuthorId,
  type EntryId
} from "@whetstone/domain";
import type {
  ImportMarkdownWorkRequest,
  IngestEpubResultDto,
  IngestMarkdownRequest,
  WorkContentDto
} from "@whetstone/contracts";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import type { EpubParser } from "../../files/epubSource.js";
import type { ImageResourceStore } from "../../files/imageResourceStore.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { authors, entries, workMeta, workSources } from "../../db/schema.js";
import { resolveNamedAuthor } from "../library/authorResolver.js";
import { reconcileWorkBlocks } from "./blockReconciler.js";
import { claimUploadedSource } from "./sourceClaims.js";
import type { IngestionEvidence } from "./htmlToDocument.js";
import { assertContentPersisted } from "./insertBatching.js";
import { loadWorkContent, loadWorkOrigin, workHasSource } from "./contentQueries.js";

// Real infrastructure boundaries (database, id generation, source file store, EPUB
// parser, image-resource store) are passed in so ingestion stays deterministic and testable.
export type ContentDependencies = Readonly<{
  createAuthorId: () => string;
  createEntryId: () => string;
  createSourceId: () => string;
  db: DbClient;
  epubParser: EpubParser;
  epubUploadLimitBytes: number;
  imageResourceStore: Pick<ImageResourceStore, "store">;
  // Fail-loud sink for the structured evidence of unrecognized block-level elements found during
  // EPUB ingestion (#311). Injected so the ingestion flow records what it could not model rather
  // than silently dropping it; the composition root logs through the server logger / console.
  ingestionLogger: (records: ReadonlyArray<IngestionEvidence>) => void;
  sourceFileStore: SourceFileStore;
}>;

export type IngestMarkdownResult =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "empty_content" }>
  | Readonly<{ status: "manual_work_unsupported" }>
  | Readonly<{ status: "work_not_found" }>;

// The front-door result for minting an imported Work from an uploaded .md file (#706). `created` wrote
// a new Work + its retained source + its single-owner claim atomically; `exact_existing` reopened the
// Work that already owns these exact bytes (no duplicate). `empty_content` and `author_not_found` are
// refused before any source file is written.
export type CreateImportedMarkdownWorkResult =
  | Readonly<{ result: IngestEpubResultDto; status: "created" | "exact_existing" }>
  | Readonly<{ status: "empty_content" }>
  | Readonly<{ status: "author_not_found"; authorId: AuthorId }>;

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
  const origin = await loadWorkOrigin(dependencies.db, workEntryId);
  if (origin === undefined) {
    return { status: "work_not_found" };
  }

  // A manual-origin Work owns a canonical ProseMirror document edited only through the manual-Work editor
  // (#720). Legacy Markdown ingestion (and PDF, which converges here) into it is refused so the two content
  // formats never mix and corrupt the document; imported Works are unaffected.
  if (origin === "manual") {
    return { status: "manual_work_unsupported" };
  }

  const decomposed = decomposeMarkdown(source.markdown);
  const newBlocks = decomposed.flatMap((unit) => unit.blocks);

  // Markdown that yields no readable blocks — e.g. image-only input, since v0 has no image block —
  // is unsupported content, not an empty success. Report it and leave the work's content unchanged
  // (don't persist provenance or wipe any existing content).
  if (newBlocks.length === 0) {
    return { status: "empty_content" };
  }

  const current = await loadWorkContent(dependencies.db, workEntryId);

  const currentNodes = current.readingUnits.flatMap((unit) =>
    unit.blocks.map((block) => block.mdast)
  );
  const newNodes = newBlocks.map((block) => block.mdast);

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

  const content = assertContentPersisted(
    newBlocks.length,
    await loadWorkContent(dependencies.db, workEntryId)
  );

  return { content, status: "ingested" };
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

type ContentTransaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// The input for the shared uploaded-Markdown commit (#706, #747). Either the caller stages nothing and
// the commit writes the retained `.md` file itself (the one-step front door), or the caller supplies a
// `stagedSource` it already wrote — a review attempt's owned stage (#725) — whose bytes are transferred
// to provenance in place rather than re-written. `sha256` keys the single-owner claim either way.
export type CommitImportedMarkdownInput = Readonly<{
  author: ImportMarkdownWorkRequest["author"];
  fileName: string;
  language: ImportMarkdownWorkRequest["language"];
  markdown: string;
  title: string;
  workType: ImportMarkdownWorkRequest["workType"];
  // A pre-written stage this commit transfers to provenance instead of writing a new source file. When
  // absent, the commit writes the `.md` file itself. `path` is the retained source's relative path.
  stagedSource?: Readonly<{ path: string }>;
}>;

// Mint an imported Work from uploaded Markdown through the shared uploaded-source claim boundary (#706),
// so the front door mirrors the EPUB path: identical bytes reopen the owning Work instead of creating a
// duplicate. The Work, its retained source file, its blocks, and its single-owner claim are written in a
// single transaction; a concurrent loser rolls the whole creation back and reopens the winner. Empty
// content and an unknown existing-author selection are refused before any source file is staged. When a
// `stagedSource` is supplied (the reviewed-creation flow, #747), its already-written bytes become the
// provenance file in place — the staged upload is transferred, never re-written or double-owned.
export async function commitImportedMarkdownWork(
  dependencies: ContentDependencies,
  input: CommitImportedMarkdownInput
): Promise<CreateImportedMarkdownWorkResult> {
  const decomposed = decomposeMarkdown(input.markdown);
  const newBlocks = decomposed.flatMap((unit) => unit.blocks);

  // Markdown that yields no readable blocks (e.g. image-only input) is unsupported content, not an
  // empty Work — refuse it before staging so no source file or shell Work is ever written.
  if (newBlocks.length === 0) {
    return { status: "empty_content" };
  }

  // Validate an existing-author selection up front (a read) so a bad id never stages a source file.
  if (input.author.mode === "existing") {
    const found = await dependencies.db
      .select({ id: authors.id })
      .from(authors)
      .where(eq(authors.id, input.author.authorId))
      .limit(1);

    if (found[0] === undefined) {
      return { status: "author_not_found", authorId: input.author.authorId };
    }
  }

  const sourceId = dependencies.createSourceId();
  const { assignments } = diffBlocks(
    [],
    newBlocks.map((block) => ({ plaintext: block.plaintext }))
  );

  const outcome = await claimUploadedSource(dependencies.db, {
    sha256: dependencies.sourceFileStore.hashMarkdown(input.markdown),
    // Reuse the caller's already-written stage in place when transferring a review attempt's upload
    // (#747); otherwise write the retained `.md` source now. Either way `commit` points the source row
    // at `written.path`, so provenance is a single owned file.
    stage: () =>
      input.stagedSource === undefined
        ? dependencies.sourceFileStore.writeMarkdownSource({
            id: sourceId,
            markdown: input.markdown
          })
        : Promise.resolve({
            path: input.stagedSource.path,
            sha256: dependencies.sourceFileStore.hashMarkdown(input.markdown)
          }),
    releaseStage: (written) => dependencies.sourceFileStore.deleteSourceFile(written.path),
    commit: async (tx, written) => {
      const authorId = await resolveWorkAuthor(tx, dependencies, input.author);
      const workEntryId = toEntryId(dependencies.createEntryId());
      await tx.insert(entries).values({ id: workEntryId, type: "work" });
      await tx.insert(workMeta).values({
        authorId,
        entryId: workEntryId,
        language: input.language,
        origin: "imported",
        title: input.title,
        workType: input.workType
      });
      await tx.insert(workSources).values({
        fileName: input.fileName,
        filePath: written.path,
        id: sourceId,
        kind: "upload",
        sha256: written.sha256,
        sourceText: null,
        workEntryId
      });
      await reconcileWorkBlocks(tx, {
        assignments,
        createEntryId: dependencies.createEntryId,
        oldUnitIds: [],
        removedIds: [],
        units: decomposed,
        workEntryId
      });

      return {
        expectedBlockCount: newBlocks.length,
        work: {
          authorId,
          entryId: workEntryId,
          language: input.language,
          origin: "imported",
          title: input.title,
          workType: input.workType
        },
        workEntryId
      };
    }
  });

  return { result: { content: outcome.content, work: outcome.work }, status: outcome.status };
}

// The one-step Markdown front door (#706): mint an imported Work from an uploaded `.md` file's metadata
// plus bytes. A thin adapter over the shared commit that always writes its own retained source file.
export async function createImportedMarkdownWork(
  dependencies: ContentDependencies,
  request: ImportMarkdownWorkRequest
): Promise<CreateImportedMarkdownWorkResult> {
  return commitImportedMarkdownWork(dependencies, {
    author: request.author,
    fileName: request.fileName,
    language: request.language,
    markdown: request.markdown,
    title: request.title,
    workType: request.workType
  });
}

// Resolve the Work's author inside the creation transaction: a `new` selection upserts through the
// canonical author identity boundary; an `existing` selection reuses its already-validated id.
async function resolveWorkAuthor(
  tx: ContentTransaction,
  dependencies: ContentDependencies,
  selection: ImportMarkdownWorkRequest["author"]
): Promise<AuthorId> {
  if (selection.mode === "new") {
    const resolved = await resolveNamedAuthor(tx, dependencies.createAuthorId, selection.name);

    return resolved.author.id;
  }

  return selection.authorId;
}
