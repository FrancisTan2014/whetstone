import {
  parsePdfImportBeginResultDto,
  parsePdfImportViewDto,
  pdfContentType,
  type PdfImportBeginResultDto,
  type PdfImportViewDto
} from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

// The learner's upload-time intent that rides alongside the born-digital PDF bytes (#702). The file name
// is required (its stem is the title fallback and it is recorded as provenance); title/author/language are
// optional overrides. This is sent as base64-encoded JSON in a header so the request body stays the raw
// PDF bytes and non-ASCII metadata survives a header that only carries ASCII.
export type PdfImportMetadata = Readonly<{
  fileName: string;
  enteredTitle?: string | null;
  enteredAuthor?: string | null;
  enteredLanguage?: string | null;
}>;

const metadataHeader = "x-pdf-import-metadata";

function encodeMetadata(metadata: PdfImportMetadata): string {
  const json = JSON.stringify(metadata);
  // btoa handles Latin-1 only; encode UTF-8 first so non-ASCII titles/authors survive the base64 header.
  return btoa(String.fromCharCode(...new TextEncoder().encode(json)));
}

// Start a born-digital PDF import: stream the file's bytes into #721's staged attempt (or, when identical
// bytes already own a Work via #706, reopen that Work with no new attempt). Passing the `File` (a `Blob`)
// straight as the request body lets the browser stream it from disk — the whole PDF is never read into a
// JS `ArrayBuffer` first. The caller polls `attemptId` for a queued result, or opens `workEntryId`
// directly for a reopened one.
export async function beginPdfImport(
  file: File,
  metadata: PdfImportMetadata
): Promise<PdfImportBeginResultDto> {
  const path = apiUrl("/pdf-imports");
  const response = await fetch(path, {
    body: file,
    headers: { "content-type": pdfContentType, [metadataHeader]: encodeMetadata(metadata) },
    method: "POST"
  });

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return parsePdfImportBeginResultDto(await response.json());
}

// Poll one import's combined execution + publication view. Returns null when the attempt no longer exists
// for this user (e.g. a stale reopened id), so the caller can drop a dead in-flight session.
export async function fetchPdfImportView(attemptId: string): Promise<PdfImportViewDto | null> {
  const path = apiUrl(`/pdf-imports/${encodeURIComponent(attemptId)}`);
  const response = await fetch(path);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return parsePdfImportViewDto(await response.json());
}

// Cancel an in-flight import; the server terminates the owned conversion child and removes its stage.
export async function cancelPdfImport(attemptId: string): Promise<PdfImportViewDto | null> {
  return mutatePdfImport(attemptId, "cancel");
}

// Retry an interrupted import; the server resumes conversion after the last committed range.
export async function retryPdfImport(attemptId: string): Promise<PdfImportViewDto | null> {
  return mutatePdfImport(attemptId, "retry");
}

async function mutatePdfImport(
  attemptId: string,
  action: "cancel" | "retry"
): Promise<PdfImportViewDto | null> {
  const path = apiUrl(`/pdf-imports/${encodeURIComponent(attemptId)}/${action}`);
  const response = await fetch(path, { method: "POST" });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return parsePdfImportViewDto(await response.json());
}

export type { PdfImportBeginResultDto, PdfImportViewDto };
