import { concatenateRanges, type WorkContentDto, type WorkDto } from "@whetstone/contracts";
import type { PdfImportStartedDto } from "@whetstone/contracts";
import { toEntryId, workLanguages, type WorkLanguage } from "@whetstone/domain";

import type { DbClient } from "../../db/dbClient.js";
import { entries, pdfBlockEvidence, workMeta, workSources } from "../../db/schema.js";
import { hashBytes } from "../../files/sourceFileStore.js";
import { writeReadingUnits } from "../content/blockWriter.js";
import { insertInBatches } from "../content/insertBatching.js";
import { claimUploadedSource, findClaimedWork } from "../content/sourceClaims.js";
import { resolveNamedAuthor } from "../library/authorResolver.js";
import { mapStructuredDocument, type PdfBlockEvidence } from "./pdfCanonicalMapping.js";
import { startPdfImport, type PdfImportCommandDependencies } from "./pdfImportCommands.js";
import {
  getAttemptById,
  getCommittedRanges,
  getPublication,
  insertPublicationIntent,
  linkPublishedWork,
  markPublicationOcrRequired,
  PDF_IMPORT_ADAPTER_FINGERPRINT
} from "./pdfImportStore.js";

// #702's publication layer: turn a converted #721 attempt into a canonical Author->Work->ReadingUnit
// ->Block Work (doc_blocks only), or record a typed OCR-required outcome, and reopen identical bytes
// through #706's exact-source claim. The #721 attempt stays pure execution — this owns the mapping,
// metadata resolution, atomic commit, and terminal publication state.

type Transaction = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

// What `beginPdfImport` did with an upload: it reopened the Work that already owns the bytes (identical
// upload), or it queued a fresh recoverable attempt whose completion the drain loop will publish.
export type BeginPdfImportResult =
  | Readonly<{ outcome: "reopened"; work: WorkDto; content: WorkContentDto }>
  | Readonly<{ outcome: "queued"; started: PdfImportStartedDto }>;

export type BeginPdfImportDependencies = Readonly<{
  db: DbClient;
  start: PdfImportCommandDependencies;
}>;

export type BeginPdfImportInput = Readonly<{
  userId: string;
  bytes: Uint8Array;
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

// Reopen the Work that already owns these exact bytes (identical-upload dedup, #706) before staging any
// conversion; otherwise stage a fresh recoverable attempt (#721) and record the learner's capture-time
// intent so publication can resolve its metadata after conversion.
export async function beginPdfImport(
  deps: BeginPdfImportDependencies,
  input: BeginPdfImportInput
): Promise<BeginPdfImportResult> {
  const sha256 = hashBytes(input.bytes);
  const claimed = await findClaimedWork(deps.db, sha256);
  if (claimed !== undefined) {
    return { outcome: "reopened", work: claimed.work, content: claimed.content };
  }

  const started = await startPdfImport(deps.start, { userId: input.userId, bytes: input.bytes });
  await insertPublicationIntent(deps.db, {
    attemptId: started.attemptId,
    enteredTitle: normalizeEntered(input.enteredTitle),
    enteredAuthor: normalizeEntered(input.enteredAuthor),
    enteredLanguage: normalizeEntered(input.enteredLanguage),
    fileName: input.fileName
  });
  return { outcome: "queued", started };
}

export type PdfImportPublishDependencies = Readonly<{
  db: DbClient;
  createEntryId: () => string;
  createAuthorId: () => string;
  createSourceId: () => string;
  now: () => Date;
}>;

// The result of attempting to publish a converted attempt. `skipped` = the attempt was not started
// through `beginPdfImport` (no publication intent); `already_published` = its outcome was resolved by a
// prior tick (idempotent); `not_ready` = the attempt is not `converted`; `ocr_required` = a typed refusal
// with no Work; `published` = a canonical Work (freshly created, or reopened for identical bytes).
export type PublishConvertedResult =
  | Readonly<{ status: "skipped" }>
  | Readonly<{ status: "already_published" }>
  | Readonly<{ status: "not_ready" }>
  | Readonly<{ status: "ocr_required"; pagesNeedingOcr: number }>
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

// Publish one converted attempt, idempotently. Reconstructs the structured document from the committed
// ranges (#721 checkpoints), maps it to canonical doc_blocks (or a typed OCR-required outcome), and — for
// a mapped document — commits Work metadata, immutable source provenance, the exact-source claim (#706),
// reading units, doc_blocks, additive block evidence, and the terminal publication state in a single
// transaction. Identical bytes reopen the owning Work instead of creating a duplicate.
export async function publishConvertedPdfImport(
  deps: PdfImportPublishDependencies,
  attemptId: string
): Promise<PublishConvertedResult> {
  const publication = await getPublication(deps.db, attemptId);
  if (publication === null) {
    return { status: "skipped" };
  }
  if (publication.workEntryId !== null || publication.ocrRequiredPages !== null) {
    return { status: "already_published" };
  }

  const attempt = await getAttemptById(deps.db, attemptId);
  if (attempt === null || attempt.state !== "converted") {
    return { status: "not_ready" };
  }

  const fingerprint = attempt.adapterFingerprint ?? PDF_IMPORT_ADAPTER_FINGERPRINT;
  const ranges = await getCommittedRanges(deps.db, attemptId, fingerprint);
  // The source metadata is unused by the mapping (which reads only pages + body) and is not persisted;
  // provenance is the sha256 claim. `byteLength` is therefore a placeholder here.
  const document = concatenateRanges(
    { sha256: attempt.sourceHash, byteLength: 0, pageCount: attempt.totalPages ?? 0 },
    ranges
  );

  const mapping = mapStructuredDocument(document);
  if (mapping.status === "ocr_required") {
    await markPublicationOcrRequired(deps.db, attemptId, mapping.pagesNeedingOcr, deps.now());
    return { status: "ocr_required", pagesNeedingOcr: mapping.pagesNeedingOcr };
  }

  const title = resolveTitle(publication.enteredTitle, publication.fileName);
  const language = resolveLanguage(publication.enteredLanguage);
  const authorName = resolveAuthorName(publication.enteredAuthor);
  const sourceId = deps.createSourceId();
  const expectedBlockCount = mapping.units.reduce(
    (total, unit) => total + unit.docBlocks.length,
    0
  );

  const outcome = await claimUploadedSource<undefined>(deps.db, {
    sha256: attempt.sourceHash,
    // A born-digital PDF retains no source file — the immutable provenance is the sha256 claim plus the
    // structured evidence — so there is nothing to stage or release.
    stage: async () => undefined,
    /* v8 ignore next -- a born-digital PDF retains no source file, so releasing the stage is a no-op
       with nothing to assert; it runs only when the claim transaction fails, a boundary path already
       exercised by sourceClaims' Markdown/EPUB mid-stage race tests. */
    releaseStage: async () => {},
    commit: async (tx) => {
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
        filePath: null,
        id: sourceId,
        kind: "upload",
        sha256: attempt.sourceHash,
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
  return { status: "published", work: outcome.work, reopened: outcome.status === "exact_existing" };
}
