import { concatenateRanges } from "@whetstone/contracts";
import { ocrTesseractLanguage, toEntryId, type EntryId } from "@whetstone/domain";
import { eq } from "drizzle-orm";

import type { DbClient } from "../../db/dbClient.js";
import { workMeta } from "../../db/schema.js";
import {
  replaceWorkContent,
  type ReplaceWorkContentResult
} from "../content/editableWorkContent.js";
import { claimWorkContentRevision } from "../content/workContentRevision.js";
import { writeBlockEvidence } from "./pdfBlockEvidenceWriter.js";
import { mapStructuredDocument } from "./pdfCanonicalMapping.js";
import {
  getCommittedRanges,
  getPublishingAttemptForWork,
  PDF_IMPORT_ADAPTER_FINGERPRINT
} from "./pdfImportStore.js";

// Re-map an already-published PDF Work from the converted payload it already retains (#861).
//
// Publication frees only the attempt's STAGE (the uploaded PDF bytes and figure artifacts); the validated
// per-range converted payload stays in `pdf_import_ranges`, one row per range, each stamped with its
// structured-document schema version and docling schema. That payload is the whole input the canonical
// mapping ever reads, so when the mapper improves, an existing Work can be rebuilt to the new quality from
// what is already stored — no re-upload, no re-conversion, no converter process at all. This module never
// imports or invokes the converter; the only work it does is read rows, run the same
// `concatenateRanges` -> `mapStructuredDocument` pair publication runs, and write canonical blocks.
//
// It is deliberately a COMMAND, not an HTTP route: re-mapping a whole Work is an operator action taken
// deliberately after a mapper change, not something a reader triggers.

export type RemapPdfWorkDependencies = Readonly<{
  createEntryId: () => string;
  db: DbClient;
}>;

// Every way a re-map can end. Only `remapped` writes anything: each refusal leaves the Work exactly as it
// was, so an operator can re-run the command after resolving the cause without having damaged content.
export type RemapPdfWorkResult =
  | Readonly<{
      status: "remapped";
      title: string;
      before: ReplaceWorkContentResult["before"];
      after: ReplaceWorkContentResult["after"];
    }>
  // No Work with that entry id.
  | Readonly<{ status: "work_not_found" }>
  // The Work exists but was not published from a PDF import (an EPUB/Markdown import, or an authored or
  // manual Work): there is no retained converted payload to re-map from.
  | Readonly<{ status: "not_pdf_imported"; title: string }>
  // A human has hand-corrected this Work's content (#762's durable marker). A human's correction outranks
  // an automated improvement, so the re-map refuses — with no override flag: the point of the marker is
  // that the decision is not the operator's to wave away in the moment.
  | Readonly<{ status: "manually_corrected"; title: string; correctedAt: Date }>
  // The publishing attempt retains no ranges under the current adapter fingerprint, so there is nothing to
  // re-map from. Refused rather than replaying an empty document, which would silently empty the Work.
  | Readonly<{ status: "no_retained_ranges"; title: string; attemptId: string }>
  // The retained payload no longer maps to a publishable document (a mapper that now refuses it). The Work
  // keeps the content it has: a refusal is not a reason to make a readable Work unreadable.
  | Readonly<{ status: "mapping_refused"; title: string; mappingStatus: string }>
  // Someone else advanced the Work's content revision between the read and the write — a concurrent
  // correction or another re-map. The loser writes nothing.
  | Readonly<{ status: "conflict"; title: string }>;

type WorkRow = Readonly<{
  contentRevision: number;
  manualCorrectionsAt: Date | null;
  title: string;
}>;

async function loadWork(db: DbClient, workEntryId: EntryId): Promise<WorkRow | undefined> {
  const [row] = await db
    .select({
      contentRevision: workMeta.contentRevision,
      manualCorrectionsAt: workMeta.manualCorrectionsAt,
      title: workMeta.title
    })
    .from(workMeta)
    .where(eq(workMeta.entryId, workEntryId));
  return row;
}

// Re-map one published Work, reporting what its content was before and after.
//
// The refusal ladder runs BEFORE anything is written, in the order that gives the operator the most
// specific reason: unknown Work, then not-a-PDF-import, then hand-corrected, then nothing retained to
// re-map from, then a payload the mapper now refuses. Only after all of those does the write open.
//
// Concurrency is fenced on the Work's `content_revision` (#703) exactly as an editable-Work save is: the
// revision is read with the Work, and the write only lands if a compare-and-set still matches it inside the
// transaction. That also closes the gap on the correction check — a correction save claims the same fence,
// so a human who corrects the Work after this command read it wins the race and the re-map loses it.
//
// Figure images are NOT re-stored: the image store is content-addressed by the sha256 the canonical `image`
// node already carries, publication stored those bytes, and the retained payload yields the same digests —
// so re-mapped figures resolve against bytes that are already there, from a stage that is long gone.
export async function remapPublishedPdfWork(
  deps: RemapPdfWorkDependencies,
  workEntryIdInput: string
): Promise<RemapPdfWorkResult> {
  const workEntryId = toEntryId(workEntryIdInput);
  const work = await loadWork(deps.db, workEntryId);
  if (work === undefined) {
    return { status: "work_not_found" };
  }
  const title = work.title;

  if (work.manualCorrectionsAt !== null) {
    return { correctedAt: work.manualCorrectionsAt, status: "manually_corrected", title };
  }

  const attempt = await getPublishingAttemptForWork(deps.db, workEntryId);
  if (attempt === null) {
    return { status: "not_pdf_imported", title };
  }

  const fingerprint = attempt.adapterFingerprint ?? PDF_IMPORT_ADAPTER_FINGERPRINT;
  const ranges = await getCommittedRanges(deps.db, attempt.id, fingerprint);
  if (ranges.length === 0) {
    return { attemptId: attempt.id, status: "no_retained_ranges", title };
  }

  // Reconstruct exactly as publication does. The source metadata is carried, never read by the mapping
  // (which reads only pages + body), and never re-persisted here: the Work's provenance is the already
  // stored source file and its sha256 claim, which this command does not touch. The page count is taken
  // from the retained ranges themselves — the pages actually being re-mapped — rather than from the
  // attempt's probe total, which is a converter-time figure this command has no reason to trust.
  const document = concatenateRanges(
    {
      byteLength: 0,
      pageCount: ranges.reduce((total, range) => total + range.pages.length, 0),
      sha256: attempt.sourceHash
    },
    ranges
  );
  const mapping = mapStructuredDocument(document);
  if (mapping.status !== "mapped") {
    return { mappingStatus: mapping.status, status: "mapping_refused", title };
  }

  // Per-block OCR provenance travels with the rebuilt blocks (#745): `pdf_block_evidence` cascades on the
  // block it describes, so re-mapped blocks would otherwise silently lose the record of the OCR engine and
  // language their text came from.
  const ocrProvenance =
    attempt.ocrFingerprint === null
      ? null
      : {
          engine: attempt.ocrFingerprint,
          language: ocrTesseractLanguage(attempt.ocrLanguage)
        };

  return deps.db.transaction(async (tx) => {
    const claimed = await claimWorkContentRevision(tx, workEntryId, work.contentRevision);
    if (claimed === undefined) {
      return { status: "conflict", title };
    }

    const counts = await replaceWorkContent(tx, {
      createEntryId: deps.createEntryId,
      units: mapping.units,
      workEntryId
    });
    await writeBlockEvidence(tx, workEntryId, mapping.evidence, ocrProvenance);

    return { after: counts.after, before: counts.before, status: "remapped", title };
  });
}
