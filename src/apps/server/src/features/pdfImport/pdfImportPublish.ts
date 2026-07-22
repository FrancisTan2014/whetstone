import { concatenateRanges, type WorkContentDto, type WorkDto } from "@whetstone/contracts";
import type { PdfImportStartedDto } from "@whetstone/contracts";
import { toEntryId, workLanguages, type WorkLanguage } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { entries, pdfBlockEvidence, workMeta, workSources } from "../../db/schema.js";
import { type SourceFileStore } from "../../files/sourceFileStore.js";
import { writeReadingUnits } from "../content/blockWriter.js";
import { insertInBatches } from "../content/insertBatching.js";
import { claimUploadedSource, findClaimedWork } from "../content/sourceClaims.js";
import { resolveNamedAuthor } from "../library/authorResolver.js";
import { mapStructuredDocument, type PdfBlockEvidence } from "./pdfCanonicalMapping.js";
import {
  bindStagedPdfAttempt,
  discardStagedPdfUpload,
  stagePdfUpload,
  type PdfImportCommandDependencies
} from "./pdfImportCommands.js";
import type { PdfImportCleanupLogger } from "./pdfImportRunner.js";
import type { PdfImportStageStore } from "./pdfImportStage.js";
import {
  clearStagePath,
  getAttemptById,
  getCommittedRanges,
  getPublication,
  insertPublicationIntent,
  linkPublishedWork,
  markPublicationNoContent,
  markPublicationOcrRequired,
  PDF_IMPORT_ADAPTER_FINGERPRINT
} from "./pdfImportStore.js";

// #702's publication layer: turn a converted #721 attempt into a canonical Author->Work->ReadingUnit
// ->Block Work (doc_blocks only), or record a typed OCR-required outcome, and reopen identical bytes
// through #706's exact-source claim. The #721 attempt stays pure execution — this owns the mapping,
// metadata resolution, atomic commit, and terminal publication state.

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What `beginPdfImport` did with an upload: it reopened the Work that already owns the bytes (identical
// upload), queued a fresh recoverable attempt whose completion the drain loop will publish, or found the
// upload empty (nothing to import).
export type BeginPdfImportResult =
  | Readonly<{ outcome: "reopened"; work: WorkDto; content: WorkContentDto }>
  | Readonly<{ outcome: "queued"; started: PdfImportStartedDto }>
  | Readonly<{ outcome: "empty" }>;

export type BeginPdfImportDependencies = Readonly<{
  db: DbClient;
  start: PdfImportCommandDependencies;
}>;

export type BeginPdfImportInput = Readonly<{
  userId: string;
  // The uploaded PDF as a byte stream (the raw request body) plus its byte bound: the upload is streamed
  // into the staging/hash boundary and never buffered whole in memory.
  source: AsyncIterable<Uint8Array>;
  maxBytes: number;
  fileName: string;
  enteredTitle?: string | null;
  enteredAuthor?: string | null;
  enteredLanguage?: string | null;
}>;

// Trim entered metadata and treat an empty/whitespace value as absent, so the resolution ladder falls
// through to the next source rather than publishing a blank title/author.
function normalizeEntered(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

// Stream the upload into a bounded staged file, hashing as the bytes arrive (the whole PDF is never
// materialized in memory — GUIDELINES: no route buffers an entire source merely to hash or persist it).
// Then, from the streamed sha256: reject an empty upload, reopen the Work that already owns these exact
// bytes (identical-upload dedup, #706) discarding the redundant stage, or bind a fresh recoverable
// attempt (#721) and record the learner's capture-time intent so publication can resolve its metadata
// after conversion. An oversize upload rejects with `PdfUploadTooLargeError` from the stage store.
export async function beginPdfImport(
  deps: BeginPdfImportDependencies,
  input: BeginPdfImportInput
): Promise<BeginPdfImportResult> {
  const staged = await stagePdfUpload(deps.start, {
    source: input.source,
    maxBytes: input.maxBytes
  });

  if (staged.byteLength === 0) {
    // An empty upload has nothing to import: drop the staged bytes and report it as invalid.
    await discardStagedPdfUpload(deps.start, {
      attemptId: staged.attemptId,
      stagePath: staged.stagePath
    });
    return { outcome: "empty" };
  }

  const claimed = await findClaimedWork(deps.db, staged.sha256);
  if (claimed !== undefined) {
    // Identical bytes already own a Work: the freshly-staged bytes are redundant, so drop them and
    // reopen the existing Work without queuing a new attempt.
    await discardStagedPdfUpload(deps.start, {
      attemptId: staged.attemptId,
      stagePath: staged.stagePath
    });
    return { outcome: "reopened", work: claimed.work, content: claimed.content };
  }

  // Bind the queued attempt and record the learner's capture-time intent atomically: the queued row and
  // its #702 publication intent commit in one transaction, so a conversion can never race ahead of an
  // attempt that has no intent (which would later publish as `skipped`). If the intent insert fails, the
  // attempt row is rolled back with it and the freshly-staged bytes are discarded.
  const started = await bindStagedPdfAttempt(deps.start, {
    attemptId: staged.attemptId,
    stagePath: staged.stagePath,
    sha256: staged.sha256,
    userId: input.userId,
    commitWithin: (tx) =>
      insertPublicationIntent(tx, {
        attemptId: staged.attemptId,
        enteredTitle: normalizeEntered(input.enteredTitle),
        enteredAuthor: normalizeEntered(input.enteredAuthor),
        enteredLanguage: normalizeEntered(input.enteredLanguage),
        fileName: input.fileName
      })
  });
  return { outcome: "queued", started };
}

export type PdfImportPublishDependencies = Readonly<{
  db: DbClient;
  createEntryId: () => string;
  createAuthorId: () => string;
  createSourceId: () => string;
  now: () => Date;
  // The staged-bytes reader (#721) and the immutable source-file store (#706): publication reads the
  // original uploaded PDF back from its retained stage and writes it through the source-file boundary so
  // every published Work keeps its source bytes for provenance/export/re-ingestion.
  stageStore: Pick<PdfImportStageStore, "readStage" | "removeStage">;
  sourceFileStore: Pick<SourceFileStore, "writePdfSource" | "deleteSourceFile">;
  // A retained stage that could not be removed after a terminal publication stays VISIBLE (logged, never
  // silently swallowed); the durable provenance already lives in the source-file store by then.
  logCleanupFailure: PdfImportCleanupLogger;
}>;

// The result of attempting to publish a converted attempt. `skipped` = the attempt was not started
// through `beginPdfImport` (no publication intent); `already_published` = its outcome was resolved by a
// prior tick (idempotent); `not_ready` = the attempt is not `converted`; `ocr_required` = a typed refusal
// with no Work (a page lacked native text); `no_content` = a typed refusal with no Work (the pages had
// native text but mapped to zero canonical blocks); `published` = a canonical Work (freshly created, or
// reopened for identical bytes).
export type PublishConvertedResult =
  | Readonly<{ status: "skipped" }>
  | Readonly<{ status: "already_published" }>
  | Readonly<{ status: "not_ready" }>
  | Readonly<{ status: "ocr_required"; pagesNeedingOcr: number }>
  | Readonly<{ status: "no_content" }>
  | Readonly<{ status: "published"; work: WorkDto; reopened: boolean }>;

// The document metadata resolution ladder (#702): entered value first, then — a born-digital PDF exposes
// no cleaned document metadata through #701 — the filename stem, then a neutral default. A raw path is
// never exposed: the stem strips any directory portion and the extension.
function filenameStem(fileName: string): string | null {
  // Strip any directory portion (never exposing a raw path) and the extension.
  const base = fileName.replace(/^.*[\\/]/u, "");
  const stem = base.replace(/\.[^.]+$/u, "").trim();
  return stem.length > 0 ? stem : null;
}

function resolveTitle(enteredTitle: string | null, fileName: string): string {
  return enteredTitle ?? filenameStem(fileName) ?? "Untitled PDF";
}

function resolveAuthorName(enteredAuthor: string | null): string {
  return enteredAuthor ?? "Unknown";
}

// Accept an entered language only when it is one of the supported work languages; otherwise fall back to
// English, so an unrecognized or absent value never blocks publication.
function resolveLanguage(enteredLanguage: string | null): WorkLanguage {
  return workLanguages.find((candidate) => candidate === enteredLanguage) ?? "en";
}

async function writeBlockEvidence(
  tx: Transaction,
  workEntryId: string,
  evidence: readonly PdfBlockEvidence[]
): Promise<void> {
  const rows = evidence.map((item) => ({
    blockId: item.blockId,
    workEntryId,
    page: item.page,
    left: item.boundingBox.left,
    top: item.boundingBox.top,
    right: item.boundingBox.right,
    bottom: item.boundingBox.bottom,
    charStart: item.charStart,
    charEnd: item.charEnd,
    confidence: item.confidence,
    label: item.label
  }));
  await insertInBatches(rows, (batch) => tx.insert(pdfBlockEvidence).values(batch));
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Remove the retained stage once its bytes are safely durable (persisted to the source-file store for a
// published Work) or no longer needed (an OCR-required outcome publishes nothing), and — ONLY on a
// successful removal — clear the attempt's stage binding so status reports it unbound. A removal failure
// is surfaced via the cleanup logger (never swallowed) AND leaves `stagePath` set, so the attempt stays
// `bound` in status and its cleanup can be retried (via `retryPdfImportCleanup`) rather than the bytes
// lingering with no path record; the Work's provenance is unaffected because it already lives in the
// source-file store.
async function removeRetainedStage(
  deps: PdfImportPublishDependencies,
  attemptId: string,
  stagePath: string
): Promise<void> {
  try {
    await deps.stageStore.removeStage(stagePath);
  } catch (cause) {
    deps.logCleanupFailure({ attemptId, stagePath, reason: describeError(cause) });
    return;
  }
  await clearStagePath(deps.db, attemptId, deps.now());
}

// Publish one converted attempt, idempotently. Reconstructs the structured document from the committed
// ranges (#721 checkpoints), maps it to canonical doc_blocks (or a typed OCR-required outcome), and — for
// a mapped document — commits Work metadata, the original uploaded PDF as immutable source provenance
// (retained through the source-file boundary, #706), the exact-source claim, reading units, doc_blocks,
// additive block evidence, and the terminal publication state in a single transaction. Identical bytes
// reopen the owning Work instead of creating a duplicate. The retained stage is freed once its bytes are
// durable (or an OCR-required outcome makes them unneeded).
export async function publishConvertedPdfImport(
  deps: PdfImportPublishDependencies,
  attemptId: string
): Promise<PublishConvertedResult> {
  const publication = await getPublication(deps.db, attemptId);
  if (publication === null) {
    return { status: "skipped" };
  }
  if (
    publication.workEntryId !== null ||
    publication.ocrRequiredPages !== null ||
    publication.noContent !== null
  ) {
    return { status: "already_published" };
  }

  const attempt = await getAttemptById(deps.db, attemptId);
  if (attempt === null || attempt.state !== "converted") {
    return { status: "not_ready" };
  }

  // A converted attempt always retains its bound stage: the runner clears `stagePath` only on a
  // failure/cancel cleanup, and a non-converted attempt returned `not_ready` above.
  /* v8 ignore next 3 -- unreachable for a converted attempt (see above); the guard keeps the retained
     source bytes required for provenance rather than publishing a Work with no source file. */
  if (attempt.stagePath === null) {
    throw new Error(
      `Converted PDF import ${attemptId} has no retained stage to persist as provenance.`
    );
  }
  const stagePath = attempt.stagePath;

  const fingerprint = attempt.adapterFingerprint ?? PDF_IMPORT_ADAPTER_FINGERPRINT;
  const ranges = await getCommittedRanges(deps.db, attemptId, fingerprint);
  // The source metadata is unused by the mapping (which reads only pages + body) and is not persisted;
  // provenance is the retained source file plus the sha256 claim. `byteLength` is a placeholder here.
  const document = concatenateRanges(
    { sha256: attempt.sourceHash, byteLength: 0, pageCount: attempt.totalPages ?? 0 },
    ranges
  );

  const mapping = mapStructuredDocument(document);
  if (mapping.status === "ocr_required") {
    await markPublicationOcrRequired(deps.db, attemptId, mapping.pagesNeedingOcr, deps.now());
    // No Work is published, so the retained bytes are no longer needed: free the stage.
    await removeRetainedStage(deps, attemptId, stagePath);
    return { status: "ocr_required", pagesNeedingOcr: mapping.pagesNeedingOcr };
  }
  if (mapping.status === "no_content") {
    // The pages had native text but mapped to zero canonical blocks: refuse before claiming/publishing so
    // no empty-shell Work is created (#702's "no empty shell"). Record the typed terminal refusal and free
    // the retained bytes, exactly as the OCR-required path does.
    await markPublicationNoContent(deps.db, attemptId, deps.now());
    await removeRetainedStage(deps, attemptId, stagePath);
    return { status: "no_content" };
  }

  const title = resolveTitle(publication.enteredTitle, publication.fileName);
  const language = resolveLanguage(publication.enteredLanguage);
  const authorName = resolveAuthorName(publication.enteredAuthor);
  const sourceId = deps.createSourceId();
  const expectedBlockCount = mapping.units.reduce(
    (total, unit) => total + unit.docBlocks.length,
    0
  );

  const outcome = await claimUploadedSource(deps.db, {
    sha256: attempt.sourceHash,
    // Persist the ORIGINAL uploaded PDF through the immutable source-file boundary (#706), so the
    // published Work retains its source bytes for provenance/export and future correction/re-ingestion —
    // exactly as EPUB does. Only runs for a newly-created Work; identical bytes reopen and stage nothing.
    stage: async () => {
      const bytes = await deps.stageStore.readStage(stagePath);
      return deps.sourceFileStore.writePdfSource({ bytes, id: sourceId });
    },
    // A duplicate upload or a failed commit must not orphan the just-written source file.
    releaseStage: (written) => deps.sourceFileStore.deleteSourceFile(written.path),
    commit: async (tx, written) => {
      const workEntryId = toEntryId(deps.createEntryId());
      const resolved = await resolveNamedAuthor(tx, deps.createAuthorId, authorName);
      await tx.insert(entries).values({ id: workEntryId, type: "work" });
      await tx.insert(workMeta).values({
        authorId: resolved.author.id,
        entryId: workEntryId,
        language,
        origin: "imported",
        title,
        workType: "book"
      });
      await tx.insert(workSources).values({
        fileName: publication.fileName,
        filePath: written.path,
        id: sourceId,
        kind: "upload",
        sha256: written.sha256,
        sourceText: null,
        workEntryId
      });
      await writeReadingUnits(tx, {
        createEntryId: deps.createEntryId,
        startOrder: 0,
        units: mapping.units,
        workEntryId
      });
      await writeBlockEvidence(tx, workEntryId, mapping.evidence);
      // Terminal job state, atomic with the Work: a failure anywhere above leaves no readable Work and
      // no linked publication.
      await linkPublishedWork(tx, attemptId, workEntryId, deps.now());
      return {
        expectedBlockCount,
        work: {
          authorId: resolved.author.id,
          entryId: workEntryId,
          language,
          origin: "imported",
          title,
          workType: "book"
        },
        workEntryId
      };
    }
  });

  // Identical bytes reopened the owning Work (a concurrent creation's loser, or a genuine re-upload): the
  // Work already exists, so link this attempt's publication to it as its terminal state.
  if (outcome.status === "exact_existing") {
    await linkPublishedWork(deps.db, attemptId, outcome.work.entryId, deps.now());
  }
  // The Work's source bytes now live durably in the source-file store (a fresh create) or already did (a
  // reopen), so the retained stage is redundant: free it.
  await removeRetainedStage(deps, attemptId, stagePath);
  return { status: "published", work: outcome.work, reopened: outcome.status === "exact_existing" };
}
