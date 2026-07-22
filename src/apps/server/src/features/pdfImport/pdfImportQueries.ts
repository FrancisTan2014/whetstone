import type { PdfImportStatusDto } from "@whetstone/contracts";

import type { DbClient } from "../../db/dbClient.js";
import { countCommittedRanges, getAttempt, type PdfImportAttemptRecord } from "./pdfImportStore.js";

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
