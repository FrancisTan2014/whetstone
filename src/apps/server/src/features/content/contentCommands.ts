import { blocksToMarkdown, decomposeMarkdown, diffBlocks, type EntryId } from "@whetstone/domain";
import type { IngestMarkdownRequest, WorkContentDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import type { EpubParser } from "../../files/epubSource.js";
import type { ImageResourceStore } from "../../files/imageResourceStore.js";
import type { PdfToMarkdown } from "../../files/pdfToMarkdown.js";
import { PdfToolchainMissingError } from "../../files/pdfToolchain.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { workSources } from "../../db/schema.js";
import { reconcileWorkBlocks } from "./blockReconciler.js";
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

// PDF ingestion converges on the Markdown pipeline (#15): the doc-AI worker converts the PDF to clean
// Markdown one-shot, which is ingested exactly like an uploaded .md so a PDF and the equivalent .md
// decompose to identical blocks. A conversion failure (no/garbled PDF) is invalid_pdf, not a crash;
// a MISSING toolchain (no Python/Docling/OCRmyPDF on the host) is reported distinctly as
// pdf_toolchain_missing so the app can point at `pnpm setup:pdf` instead of blaming the file (#510).
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
