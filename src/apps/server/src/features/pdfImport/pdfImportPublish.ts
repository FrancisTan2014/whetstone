import { concatenateRanges, type WorkContentDto, type WorkDto } from "@whetstone/contracts";
import type { PdfImportStartedDto } from "@whetstone/contracts";
import {
  ocrTesseractLanguage,
  resolveOcrLanguage,
  resolveWorkLanguage,
  toEntryId,
  type WorkLanguage
} from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { entries, pdfBlockEvidence, workMeta, workSources } from "../../db/schema.js";
import type { ImageResourceStore } from "../../files/imageResourceStore.js";
import { hashBytes, type SourceFileStore } from "../../files/sourceFileStore.js";
import { writeReadingUnits } from "../content/blockWriter.js";
import { insertInBatches } from "../content/insertBatching.js";
import { claimUploadedSource, findClaimedWork } from "../content/sourceClaims.js";
import { resolveNamedAuthor } from "../library/authorResolver.js";
import { collectAdoptedArtifacts } from "./pdfImportArtifacts.js";
import {
  mapStructuredDocument,
  type PdfBlockEvidence,
  type PdfHeadingLevelSources
} from "./pdfCanonicalMapping.js";
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
  markPublicationOcrValidationFailed,
  markReviewPublished,
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
  // The optional pre-import OCR-language override (#746), limited to the three Work languages. Null (the
  // default) means "OCR in the Work's own language"; a non-null value wins. Resolved against the Work
  // language and frozen on the attempt row here at queue time.
  ocrLanguageOverride?: WorkLanguage | null;
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

  // Freeze the OCR language once, here at queue time (#746): the pre-import override wins over the Work's
  // own resolved language. The runner and publication both read this single stored choice, so it cannot
  // drift mid-run; a re-import is a fresh attempt that resolves its own value.
  const ocrLanguage = resolveOcrLanguage(
    resolveWorkLanguage(normalizeEntered(input.enteredLanguage)),
    input.ocrLanguageOverride ?? null
  );

  // Bind the queued attempt and record the learner's capture-time intent atomically: the queued row and
  // its #702 publication intent commit in one transaction, so a conversion can never race ahead of an
  // attempt that has no intent (which would later publish as `skipped`). If the intent insert fails, the
  // attempt row is rolled back with it and the freshly-staged bytes are discarded.
  const started = await bindStagedPdfAttempt(deps.start, {
    attemptId: staged.attemptId,
    stagePath: staged.stagePath,
    sha256: staged.sha256,
    userId: input.userId,
    ocrLanguage,
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
  // every published Work keeps its source bytes for provenance/export/re-ingestion. `readArtifact` reads
  // each adopted rendered-figure PNG (#807) back from the same retained stage.
  stageStore: Pick<PdfImportStageStore, "readStage" | "readArtifact" | "removeStage">;
  sourceFileStore: Pick<SourceFileStore, "writePdfSource" | "deleteSourceFile">;
  // The content-addressed image store (#807): each adopted figure PNG is stored here under its sha256, the
  // same id the canonical `image` node carries as `imageResourceId`, so the existing Reader serves it.
  imageResourceStore: Pick<ImageResourceStore, "store">;
  // A retained stage that could not be removed after a terminal publication stays VISIBLE (logged, never
  // silently swallowed); the durable provenance already lives in the source-file store by then.
  logCleanupFailure: PdfImportCleanupLogger;
}>;

// The result of attempting to publish a converted attempt. `skipped` = the attempt was not started
// through `beginPdfImport` (no publication intent); `already_published` = its outcome was resolved by a
// prior tick (idempotent); `not_ready` = the attempt is not `converted`; `ocr_validation_failed` = a
// typed refusal with no Work (a document still had text-less pages after the OCR pass); `no_content` = a
// typed refusal with no Work (the pages had native text but mapped to zero canonical blocks);
// `published` = a canonical Work (freshly created, or reopened for identical bytes). A published Work may
// carry `unresolvedFigureCount` unresolved figure placeholders (#806) as a non-blocking review warning.
export type PublishConvertedResult =
  | Readonly<{ status: "skipped" }>
  | Readonly<{ status: "already_published" }>
  | Readonly<{ status: "not_ready" }>
  | Readonly<{ status: "ocr_validation_failed"; pagesNeedingOcr: number }>
  | Readonly<{ status: "no_content" }>
  | Readonly<{
      status: "published";
      work: WorkDto;
      reopened: boolean;
      unresolvedFigureCount: number;
      headingLevelSources: PdfHeadingLevelSources;
    }>;

// The document metadata resolution ladder (#702): entered value first, then the source PDF's own cleaned
// metadata (#701 surfaces its title/author when the info dictionary carried them), then — for the title —
// the filename stem, then a neutral default. A raw path is never exposed: the stem strips any directory
// portion and the extension. Cleaned PDF metadata is trusted as already-trimmed, but an empty/whitespace
// value is still treated as absent so a blank Title/Author never wins over the next layer.
function filenameStem(fileName: string): string | null {
  // Strip any directory portion (never exposing a raw path) and the extension.
  const base = fileName.replace(/^.*[\\/]/u, "");
  const stem = base.replace(/\.[^.]+$/u, "").trim();
  return stem.length > 0 ? stem : null;
}

function resolveTitle(
  enteredTitle: string | null,
  metadataTitle: string | null | undefined,
  fileName: string
): string {
  return (
    enteredTitle ?? normalizeEntered(metadataTitle) ?? filenameStem(fileName) ?? "Untitled PDF"
  );
}

function resolveAuthorName(
  enteredAuthor: string | null,
  metadataAuthor: string | null | undefined
): string {
  return enteredAuthor ?? normalizeEntered(metadataAuthor) ?? "Unknown";
}

async function writeBlockEvidence(
  tx: Transaction,
  workEntryId: string,
  evidence: readonly PdfBlockEvidence[],
  // Attempt-level OCR provenance (#745): the engine fingerprint and Tesseract language every block was
  // produced under when the attempt adopted a validated OCR stage, or null for a born-digital document
  // that never went through OCR. The post-conversion projection no longer carries a per-page OCR flag, so
  // this is recorded uniformly for the attempt's blocks rather than per page.
  ocrProvenance: Readonly<{ engine: string; language: string }> | null
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
    label: item.label,
    ocrEngine: ocrProvenance?.engine ?? null,
    ocrLanguage: ocrProvenance?.language ?? null
  }));
  await insertInBatches(rows, (batch) => tx.insert(pdfBlockEvidence).values(batch));
}

function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// Read each adopted rendered-figure PNG (#807) back from the attempt's retained stage and store it in the
// content-addressed image store under its sha256 (the id the canonical `image` node already carries). The
// stage was validated at adoption time; a digest mismatch here means the retained bytes were corrupted
// after commit, so it throws loudly rather than storing wrong-content bytes under a trusted id.
async function storeAdoptedFigureImages(
  deps: PdfImportPublishDependencies,
  stagePath: string,
  document: Parameters<typeof collectAdoptedArtifacts>[0]
): Promise<void> {
  for (const artifact of collectAdoptedArtifacts(document)) {
    const bytes = await deps.stageStore.readArtifact(stagePath, artifact.path);
    if (hashBytes(bytes) !== artifact.sha256) {
      throw new Error(
        `Rendered-figure artifact "${artifact.path}" failed its digest check at publication (corrupt retained stage).`
      );
    }
    await deps.imageResourceStore.store({ bytes, contentType: "image/png" });
  }
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
    publication.ocrValidationFailedPages !== null ||
    publication.noContent !== null ||
    publication.unpreservableImages !== null
  ) {
    return { status: "already_published" };
  }

  const attempt = await getAttemptById(deps.db, attemptId);
  if (attempt === null || attempt.state !== "awaiting_review") {
    return { status: "not_ready" };
  }

  // An awaiting-review attempt always retains its bound stage: the runner clears `stagePath` only on a
  // failure/cancel cleanup, and a non-awaiting-review attempt returned `not_ready` above.
  /* v8 ignore next 3 -- unreachable for an awaiting-review attempt (see above); the guard keeps the retained
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

  const language = resolveWorkLanguage(publication.enteredLanguage);
  const mapping = mapStructuredDocument(document);
  if (mapping.status === "ocr_validation_failed") {
    // A document still had text-less pages after the OCR pass (a preflight/full-conversion disagreement
    // or incomplete OCR): refuse rather than publish a partial Work, and free the bytes.
    await markPublicationOcrValidationFailed(
      deps.db,
      attemptId,
      mapping.pagesNeedingOcr,
      deps.now()
    );
    await removeRetainedStage(deps, attemptId, stagePath);
    await markReviewPublished(deps.db, attemptId, deps.now());
    return { status: "ocr_validation_failed", pagesNeedingOcr: mapping.pagesNeedingOcr };
  }
  if (mapping.status === "no_content") {
    // The pages had native text but mapped to zero canonical blocks: refuse before claiming/publishing so
    // no empty-shell Work is created (#702's "no empty shell"). Record the typed terminal refusal and free
    // the retained bytes, exactly as the OCR-required path does.
    await markPublicationNoContent(deps.db, attemptId, deps.now());
    await removeRetainedStage(deps, attemptId, stagePath);
    await markReviewPublished(deps.db, attemptId, deps.now());
    return { status: "no_content" };
  }

  // A mapped document may carry unresolved picture/figure placeholders (#806): they publish as visible,
  // correctable figures and are recorded as a review warning on the successful publication, never a
  // refusal. An outline gap (#870) is the same kind of signal: heading depths derived from labels
  // instead of the embedded outline are worth an administrator's attention before the Work is presented
  // to a reader, and are recorded the same way.
  const unresolvedFigureCount = mapping.unresolvedFigureCount;
  const headingLevelSources = mapping.headingLevelSources;

  // Persist every adopted rendered-figure PNG (#807) into the content-addressed image store BEFORE the
  // Work is committed, so each resolved figure's `imageResourceId` (its sha256) already resolves when the
  // Reader serves it. The store is content-addressed and idempotent, so a reopened identical upload simply
  // re-confirms the already-present bytes. A digest mismatch here means the retained stage was corrupted
  // after commit — loud infra corruption, never a silent mis-serve.
  await storeAdoptedFigureImages(deps, stagePath, document);

  const title = resolveTitle(
    publication.enteredTitle,
    document.metadata?.title,
    publication.fileName
  );
  const authorName = resolveAuthorName(publication.enteredAuthor, document.metadata?.author);
  // Per-block OCR provenance (#745/#746): when the attempt adopted a validated OCR stage its fingerprint
  // is recorded; every published block was produced from that OCR'd source, in the attempt's resolved OCR
  // language (the pre-import override if one was chosen, otherwise the Work language). A born-digital
  // attempt never adopted OCR, so its blocks carry no OCR provenance.
  const ocrProvenance =
    attempt.ocrFingerprint === null
      ? null
      : { engine: attempt.ocrFingerprint, language: ocrTesseractLanguage(attempt.ocrLanguage) };
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
      await writeBlockEvidence(tx, workEntryId, mapping.evidence, ocrProvenance);
      // Terminal job state, atomic with the Work: a failure anywhere above leaves no readable Work and
      // no linked publication. The unresolved-figure count and the outline-gap counts ride along as
      // review warnings (#806, #870).
      await linkPublishedWork(
        tx,
        attemptId,
        workEntryId,
        deps.now(),
        unresolvedFigureCount,
        headingLevelSources.label,
        headingLevelSources.outline
      );
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
  // Work already exists, so link this attempt's publication to it as its terminal state. Identical bytes
  // map to the same figures and the same outline, so this attempt records the same warnings (#806, #870).
  if (outcome.status === "exact_existing") {
    await linkPublishedWork(
      deps.db,
      attemptId,
      outcome.work.entryId,
      deps.now(),
      unresolvedFigureCount,
      headingLevelSources.label,
      headingLevelSources.outline
    );
  }
  // The Work's source bytes now live durably in the source-file store (a fresh create) or already did (a
  // reopen), so the retained stage is redundant: free it.
  await removeRetainedStage(deps, attemptId, stagePath);
  // The review decision resolved: transition the awaiting-review attempt to its terminal `converted` state
  // so no further review attempt is ever minted for it. Idempotent (fenced on `awaiting_review`).
  await markReviewPublished(deps.db, attemptId, deps.now());
  return {
    reopened: outcome.status === "exact_existing",
    status: "published",
    unresolvedFigureCount,
    headingLevelSources,
    work: outcome.work
  };
}

// The metadata + provenance a converted attempt exposes to the shared Work-creation duplicate review
// (#750), read WITHOUT publishing anything. `not_awaiting` = the attempt is not `awaiting_review` (still
// converting, already resolved, or gone), so there is nothing to review; `refused` = the reconstructed
// document maps to a typed refusal (OCR-required / no-content / unsupported-image), which must be
// published as that refusal rather than reviewed; `ready` = the resolved title/author/language (through
// the same entered -> info-dict -> filename ladder publication uses) plus the source hash and file name
// the review scores duplicate candidates against. Only reads (getAttemptById/getPublication/ranges +
// pure mapping), so a repeated poll is side-effect-free until a decision publishes or discards.
export type PdfReviewSourceResult =
  | Readonly<{ status: "not_awaiting" }>
  | Readonly<{ status: "refused" }>
  | Readonly<{
      status: "ready";
      sourceHash: string;
      fileName: string | null;
      title: string;
      authorName: string;
      language: WorkLanguage;
    }>;

export async function loadPdfReviewSource(
  deps: Pick<PdfImportPublishDependencies, "db">,
  attemptId: string
): Promise<PdfReviewSourceResult> {
  const attempt = await getAttemptById(deps.db, attemptId);
  if (attempt === null || attempt.state !== "awaiting_review") {
    return { status: "not_awaiting" };
  }

  const publication = await getPublication(deps.db, attemptId);
  /* v8 ignore next 3 -- an awaiting-review attempt was started through `beginPdfImport`, which inserts the
     publication intent atomically with the queued row, so its intent always exists; the guard is defensive. */
  if (publication === null) {
    return { status: "not_awaiting" };
  }

  const fingerprint = attempt.adapterFingerprint ?? PDF_IMPORT_ADAPTER_FINGERPRINT;
  const ranges = await getCommittedRanges(deps.db, attemptId, fingerprint);
  const document = concatenateRanges(
    { sha256: attempt.sourceHash, byteLength: 0, pageCount: attempt.totalPages ?? 0 },
    ranges
  );

  if (mapStructuredDocument(document).status !== "mapped") {
    return { status: "refused" };
  }

  return {
    status: "ready",
    sourceHash: attempt.sourceHash,
    fileName: publication.fileName,
    title: resolveTitle(publication.enteredTitle, document.metadata?.title, publication.fileName),
    authorName: resolveAuthorName(publication.enteredAuthor, document.metadata?.author),
    language: resolveWorkLanguage(publication.enteredLanguage)
  };
}
