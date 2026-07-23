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
import type { PdfToMarkdown } from "../../files/pdfToMarkdown.js";
import { PdfToolchainMissingError } from "../../files/pdfToolchain.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { authors, entries, workMeta, workSources } from "../../db/schema.js";
import { resolveNamedAuthor } from "../library/authorResolver.js";
import { reconcileWorkBlocks } from "./blockReconciler.js";
import { claimUploadedSource } from "./sourceClaims.js";
import type { IngestionEvidence } from "./htmlToDocument.js";
import { assertContentPersisted } from "./insertBatching.js";
import { loadWorkContent, loadWorkOrigin, workExists, workHasSource } from "./contentQueries.js";

// Real infrastructure boundaries (database, id generation, source file store, EPUB
// parser, image-resource store, PDF worker) are passed in so ingestion stays
// deterministic and testable.
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
  pdfToMarkdown: PdfToMarkdown;
  sourceFileStore: SourceFileStore;
}>;

export type IngestMarkdownResult =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "empty_content" }>
  | Readonly<{ status: "manual_work_unsupported" }>
  | Readonly<{ status: "work_not_found" }>;

export type IngestPdfResult =
  | IngestMarkdownResult
  | Readonly<{ status: "invalid_pdf" }>
  | Readonly<{ status: "pdf_toolchain_missing" }>;

// The front-door result for minting an imported Work from an uploaded .md file (#706). `created` wrote
// a new Work + its retained source + its single-owner claim atomically; `exact_existing` reopened the
// Work that already owns these exact bytes (no duplicate). `empty_content` and `author_not_found` are
// refused before any source file is written.
export type CreateImportedMarkdownWorkResult =
  | Readonly<{ result: IngestEpubResultDto; status: "created" | "exact_existing" }>
  | Readonly<{ status: "empty_content" }>
  | Readonly<{ status: "author_not_found"; authorId: AuthorId }>;

// PDF ingestion converges on the Markdown pipeline (#15): the doc-AI worker converts the PDF to clean
// Markdown one-shot, which is ingested exactly like an uploaded .md so a PDF and the equivalent .md
// decompose to identical blocks. A conversion failure (no/garbled PDF) is invalid_pdf, not a crash;
// a MISSING toolchain (no Python/Docling/OCRmyPDF on the host) is reported distinctly as
// pdf_toolchain_missing so the app can point at `pnpm setup:pdf` instead of blaming the file (#510).
//
// Coverage: this function and its pipeline are now-unreachable dead code. The
// `POST /api/works/:workEntryId/content/pdf` route was deactivated to a 503 (#702) and no longer
// wires ingestPdf; born-digital PDFs mint their own Work through the structured `/api/pdf-imports`
// lane. It is retained only until #705 deletes the obsolete lane, so it is excluded from coverage
// rather than tested as reachable behavior.
/* v8 ignore start */
export async function ingestPdf(
  dependencies: ContentDependencies,
  workEntryId: EntryId,
  fileName: string,
  bytes: Uint8Array
): Promise<IngestPdfResult> {
  // Reject a manual-origin Work before converting: PDF (like Markdown) ingestion into a manual Work
  // is a retired legacy path (#720), so it must return the deterministic manual_work_unsupported
  // regardless of whether the PDF toolchain is installed — and never pay for an expensive/optional
  // conversion just to refuse the upload at the boundary. A missing work stays undefined here and
  // falls through to the post-convert workExists gate, preserving the existing 404 behavior.
  if ((await loadWorkOrigin(dependencies.db, workEntryId)) === "manual") {
    return { status: "manual_work_unsupported" };
  }

  let markdown: string;

  try {
    markdown = await dependencies.pdfToMarkdown.convert(bytes);
  } catch (cause) {
    return cause instanceof PdfToolchainMissingError
      ? { status: "pdf_toolchain_missing" }
      : { status: "invalid_pdf" };
  }

  // Gate before retaining anything so a failure never orphans a PDF file with no work_sources row:
  // a missing work or Markdown that yields no blocks returns without writing the source (#15).
  if (!(await workExists(dependencies.db, workEntryId))) {
    return { status: "work_not_found" };
  }

  if (decomposeMarkdown(markdown).flatMap((unit) => unit.blocks).length === 0) {
    return { status: "empty_content" };
  }

  // Provenance is the original PDF, written only on the persist path (the builder runs after the
  // no-op/idempotence check) so an equivalent re-upload never orphans a PDF file. sha256 is the PDF
  // payload, so retention and idempotence key off the bytes, not the converted Markdown (#15).
  const sourceId = dependencies.createSourceId();
  const buildPdfProvenance = async (): Promise<Provenance> => {
    const written = await dependencies.sourceFileStore.writePdfSource({ bytes, id: sourceId });
    return { fileName, filePath: written.path, sha256: written.sha256, sourceText: null };
  };

  return ingestMarkdown(
    dependencies,
    workEntryId,
    { fileName, kind: "upload", markdown },
    sourceId,
    buildPdfProvenance
  );
}
/* v8 ignore stop */

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
  source: IngestMarkdownRequest,
  sourceIdOverride?: string,
  buildProvenanceOverride?: () => Promise<Provenance>
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

  const sourceId = sourceIdOverride ?? dependencies.createSourceId();
  // `buildProvenanceOverride` is supplied only by the now-dead ingestPdf path (the PDF→Markdown route
  // was deactivated to a 503 in #702) and is retained until #705 deletes the obsolete lane. Its
  // override arm is unreachable in production, so it is excluded from coverage while the live default
  // provenance path below stays counted.
  /* v8 ignore next 3 */
  const provenance =
    buildProvenanceOverride !== undefined
      ? await buildProvenanceOverride()
      : await buildProvenance(dependencies.sourceFileStore, sourceId, source);

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

// Mint an imported Work from an uploaded .md file through the shared uploaded-source claim boundary
// (#706), so the front door mirrors the EPUB path: identical bytes reopen the owning Work instead of
// creating a duplicate. The Work, its retained source file, its blocks, and its claim are written in a
// single transaction; a concurrent loser rolls the whole creation back and reopens the winner. Unlike
// the per-work content endpoint, this creates the Work, so it also validates the metadata (empty
// content and an unknown existing-author selection are refused before any source file is staged).
export async function createImportedMarkdownWork(
  dependencies: ContentDependencies,
  request: ImportMarkdownWorkRequest
): Promise<CreateImportedMarkdownWorkResult> {
  const decomposed = decomposeMarkdown(request.markdown);
  const newBlocks = decomposed.flatMap((unit) => unit.blocks);

  // Markdown that yields no readable blocks (e.g. image-only input) is unsupported content, not an
  // empty Work — refuse it before staging so no source file or shell Work is ever written.
  if (newBlocks.length === 0) {
    return { status: "empty_content" };
  }

  // Validate an existing-author selection up front (a read) so a bad id never stages a source file.
  if (request.author.mode === "existing") {
    const found = await dependencies.db
      .select({ id: authors.id })
      .from(authors)
      .where(eq(authors.id, request.author.authorId))
      .limit(1);

    if (found[0] === undefined) {
      return { status: "author_not_found", authorId: request.author.authorId };
    }
  }

  const sourceId = dependencies.createSourceId();
  const { assignments } = diffBlocks(
    [],
    newBlocks.map((block) => ({ plaintext: block.plaintext }))
  );

  const outcome = await claimUploadedSource(dependencies.db, {
    sha256: dependencies.sourceFileStore.hashMarkdown(request.markdown),
    stage: () =>
      dependencies.sourceFileStore.writeMarkdownSource({
        id: sourceId,
        markdown: request.markdown
      }),
    releaseStage: (written) => dependencies.sourceFileStore.deleteSourceFile(written.path),
    commit: async (tx, written) => {
      const authorId = await resolveWorkAuthor(tx, dependencies, request.author);
      const workEntryId = toEntryId(dependencies.createEntryId());
      await tx.insert(entries).values({ id: workEntryId, type: "work" });
      await tx.insert(workMeta).values({
        authorId,
        entryId: workEntryId,
        language: request.language,
        origin: "imported",
        title: request.title,
        workType: request.workType
      });
      await tx.insert(workSources).values({
        fileName: request.fileName,
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
          language: request.language,
          origin: "imported",
          title: request.title,
          workType: request.workType
        },
        workEntryId
      };
    }
  });

  return { result: { content: outcome.content, work: outcome.work }, status: outcome.status };
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
