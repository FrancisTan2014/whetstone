import type { PdfImportPublicationOutcomeDto, PdfImportStatusDto, PdfImportViewDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import { countCommittedRanges, getAttempt, getPublication, type PdfImportAttemptRecord } from "./pdfImportStore.js";

// The owner-scoped status query for a recoverable staged PDF import (#721). Progress is reported as
// concrete page and range COUNTS derived from committed ranges (never a percentage parsed from a
// subprocess), plus whether the attempt still owns its stage and its typed failure when failed. No
// server path or converter payload crosses this boundary.

// Build the status DTO from an attempt record, counting its committed ranges. Shared by the status
// query and the start/cancel/retry commands so every response is shaped identically.
export async function buildPdfImportStatus(
  db: DbClient,
  record: PdfImportAttemptRecord
): Promise<PdfImportStatusDto> {
  const completedRanges = await countCommittedRanges(db, record.id);
  return {
    adapterFingerprint: record.adapterFingerprint,
    attemptId: record.id,
    completedPages: record.completedPages,
    completedRanges,
    createdAt: record.createdAt.toISOString(),
    failure: record.failure,
    heartbeatAt: record.heartbeatAt === null ? null : record.heartbeatAt.toISOString(),
    sourceHash: record.sourceHash,
    stage: { bound: record.stagePath !== null },
    state: record.state,
    totalPages: record.totalPages,
    totalRanges: record.totalRanges,
    updatedAt: record.updatedAt.toISOString()
  };
}

// Read one attempt's status for its owner. Returns null when the attempt does not exist for this user,
// so a cross-user id is indistinguishable from a missing one (no existence leak).
export async function getPdfImportStatus(
  db: DbClient,
  userId: string,
  attemptId: string
): Promise<PdfImportStatusDto | null> {
  const record = await getAttempt(db, userId, attemptId);
  return record === null ? null : buildPdfImportStatus(db, record);
}

// Project the #702 publication record into its outcome DTO: no intent -> `none`; a resolved Work ->
// `published`; a resolved OCR refusal -> `ocr_required`; otherwise still `pending`.
export async function buildPdfImportPublicationOutcome(
  db: DbClient,
  attemptId: string
): Promise<PdfImportPublicationOutcomeDto> {
  const publication = await getPublication(db, attemptId);
  if (publication === null) {
    return { status: "none" };
  }
  if (publication.workEntryId !== null) {
    return { status: "published", workEntryId: publication.workEntryId };
  }
  if (publication.ocrRequiredPages !== null) {
    return { pagesNeedingOcr: publication.ocrRequiredPages, status: "ocr_required" };
  }
  return { status: "pending" };
}

// The full owner-scoped view of one born-digital PDF import (#702): its #721 execution status plus its
// #702 publication outcome. Returns null when the attempt does not exist for this user (no existence
// leak), so the client's single poll endpoint drives the whole upload -> ready/ocr/failure journey.
export async function getPdfImportView(
  db: DbClient,
  userId: string,
  attemptId: string
): Promise<PdfImportViewDto | null> {
  const record = await getAttempt(db, userId, attemptId);
  if (record === null) {
    return null;
  }
  return {
    publication: await buildPdfImportPublicationOutcome(db, record.id),
    status: await buildPdfImportStatus(db, record)
  };
}
