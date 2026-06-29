import { blocksToMarkdown, decomposeMarkdown, diffBlocks, type EntryId } from "@whetstone/domain";
import type { IngestMarkdownRequest, WorkContentDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import type { EpubParser } from "../../files/epubSource.js";
import type { ImageResourceStore } from "../../files/imageResourceStore.js";
import type { PdfToMarkdown } from "../../files/pdfToMarkdown.js";
import type { SourceFileStore } from "../../files/sourceFileStore.js";
import { workSources } from "../../db/schema.js";
import { reconcileWorkBlocks } from "./blockReconciler.js";
import { assertContentPersisted } from "./insertBatching.js";
import { loadWorkContent, workExists, workHasSource } from "./contentQueries.js";

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
  pdfToMarkdown: PdfToMarkdown;
  sourceFileStore: SourceFileStore;
}>;

export type IngestMarkdownResult =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "empty_content" }>
  | Readonly<{ status: "work_not_found" }>;

export type IngestPdfResult = IngestMarkdownResult | Readonly<{ status: "invalid_pdf" }>;

// PDF ingestion converges on the Markdown pipeline (#15): the doc-AI worker converts the PDF to clean
// Markdown one-shot, which is ingested exactly like an uploaded .md so a PDF and the equivalent .md
// decompose to identical blocks. A conversion failure (no/garbled PDF) is invalid_pdf, not a crash.
export async function ingestPdf(
  dependencies: ContentDependencies,
  workEntryId: EntryId,
  fileName: string,
  bytes: Uint8Array
): Promise<IngestPdfResult> {
  let markdown: string;

  try {
    markdown = await dependencies.pdfToMarkdown.convert(bytes);
  } catch {
    return { status: "invalid_pdf" };
  }

  // Gate before retaining anything so a failure never orphans a PDF file with no work_sources row:
  // a missing work or Markdown that yields no blocks returns without writing the source (#15).
  if (!(await workExists(dependencies.db, workEntryId))) {
    return { status: "work_not_found" };
  }

  if (decomposeMarkdown(markdown).flatMap((unit) => unit.blocks).length === 0) {
    return { status: "empty_content" };
  }

  // Provenance is the original PDF: store the bytes with their PDF sha256, not the converted Markdown,
  // so the uploaded source is retained per PRODUCT.md and idempotence keys off the PDF payload (#15).
  const sourceId = dependencies.createSourceId();
  const written = await dependencies.sourceFileStore.writePdfSource({ bytes, id: sourceId });
  const provenance: Provenance = {
    fileName,
    filePath: written.path,
    sha256: written.sha256,
    sourceText: null
  };

  return ingestMarkdown(
    dependencies,
    workEntryId,
    { fileName, kind: "upload", markdown },
    sourceId,
    provenance
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
  provenanceOverride?: Provenance
): Promise<IngestMarkdownResult> {
  if (!(await workExists(dependencies.db, workEntryId))) {
    return { status: "work_not_found" };
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
    provenanceOverride ?? (await buildProvenance(dependencies.sourceFileStore, sourceId, source));

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
