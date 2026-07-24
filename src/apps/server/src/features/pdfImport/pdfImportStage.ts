import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import { issueStagedFileHandle, type StagedFileHandle } from "../../files/pdfStructuredAdapter.js";
import { resolveWithinDirectory } from "../../files/sourceFileStore.js";

// A streamed upload that exceeded the configured byte bound. Thrown mid-stream (the whole file is never
// buffered to discover it is too large) so the route can answer 413 instead of the process holding an
// oversized body in memory.
export class PdfUploadTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Uploaded PDF exceeds the ${maxBytes}-byte limit.`);
    this.name = "PdfUploadTooLargeError";
    this.maxBytes = maxBytes;
  }
}

// The one attempt-owned staging lifecycle (#721). A PDF import owns its staged bytes in a per-attempt
// directory under a server-owned root, SEPARATE from immutable source provenance and from readable
// content. #701's adapter never sees a user path — it only reads through the server-issued
// `StagedFileHandle` this store mints. The store removes ONLY the exact attempt-owned directory it was
// told to; it never sweeps the root by age, so an unrelated file is never deleted (a cleanup failure is
// surfaced to the caller so it stays visible and retryable).

const STAGED_FILE_NAME = "staged.pdf";

// The derived, OCR-adopted PDF (#745): a second file in the SAME attempt-owned stage directory, written
// only after the OCR pass validates. It never replaces `staged.pdf` (the immutable original kept for
// provenance) — one `removeStage` removes the whole directory, so both files share a single cleanup
// surface. Written with the `w` flag (overwrite) so a rerun of the OCR pass BEFORE adoption is safe to
// repeat; once `ocr_fingerprint` is recorded the file is the trusted structured-conversion source.
const DERIVED_OCR_FILE_NAME = "ocr.pdf";

// Server-generated attempt ids only (uuid-shaped): letters, digits, hyphen, underscore — never a path
// segment. Rejected before any filesystem touch so a crafted id cannot escape the stage root.
const safeStageIdPattern = /^[A-Za-z0-9_-]+$/;

function assertSafeStageId(stageId: string): void {
  if (!safeStageIdPattern.test(stageId)) {
    throw new Error("Stage id must contain only letters, digits, hyphen, or underscore.");
  }
}

export type CreatedStage = Readonly<{ stagePath: string; handle: StagedFileHandle }>;

// A stage written by streaming the upload straight to disk: besides the path/handle it reports the
// content sha256 (computed incrementally while streaming, so it matches `hashBytes` over the same bytes)
// and the total byte length observed, so the caller can dedup and reject an empty upload without ever
// re-reading the whole file.
export type StreamedStage = Readonly<{
  stagePath: string;
  handle: StagedFileHandle;
  sha256: string;
  byteLength: number;
}>;

export type PdfImportStageStore = Readonly<{
  // Create the attempt's secure stage: write the uploaded bytes into a fresh per-attempt directory and
  // return the relative stage path (persisted on the attempt) plus a server-issued handle #701 reads.
  // Creation is EXCLUSIVE: if a directory for this attempt id already exists (an id collision), it
  // throws instead of overwriting the existing attempt's staged bytes.
  createStage: (attemptId: string, bytes: Uint8Array) => Promise<CreatedStage>;
  // Stream the uploaded PDF into the attempt's secure stage, hashing as the bytes arrive so the whole
  // file is never resident in memory (the large-upload boundary #721 / GUIDELINES require). Enforces
  // `maxBytes` mid-stream — an oversize upload rejects with `PdfUploadTooLargeError` and leaves no stage.
  // Creation is EXCLUSIVE exactly as `createStage`: an id collision throws WITHOUT disturbing the
  // colliding attempt's bytes. A failed stream removes only the directory this call created.
  createStageFromStream: (
    attemptId: string,
    source: AsyncIterable<Uint8Array>,
    options: Readonly<{ maxBytes: number }>
  ) => Promise<StreamedStage>;
  // Re-open the handle for an already-created stage (e.g. a resumed run after restart), from the stored
  // relative stage path. Does not touch disk; the runner's read reports a missing stage as a failure.
  openStage: (stagePath: string) => StagedFileHandle;
  // Write the derived OCR PDF (#745) into the attempt's EXISTING stage directory and return a
  // server-issued handle #701 reads. Overwrites any prior derived file (a re-run before adoption is safe),
  // and never touches the immutable original `staged.pdf`. Rejects if the stage directory is missing.
  writeDerivedStage: (stagePath: string, bytes: Uint8Array) => Promise<StagedFileHandle>;
  // Re-open the handle for the derived OCR PDF (a resumed run after adoption), from the stored relative
  // stage path. Does not touch disk; a missing derived file surfaces as a read failure.
  openDerivedStage: (stagePath: string) => StagedFileHandle;
  // Read the exact staged bytes back through the server-issued handle, so publication can retain the
  // original uploaded PDF as immutable provenance without ever seeing a user-supplied path. A missing or
  // unreadable stage rejects (the caller surfaces it), never silently returns empty bytes.
  readStage: (stagePath: string) => Promise<Uint8Array>;
  // Remove exactly this attempt-owned stage directory. A missing directory is a no-op (already gone); a
  // real filesystem error (e.g. permissions) still throws so the caller surfaces it as a retryable
  // cleanup failure. Never removes anything outside the exact path, and never by age.
  removeStage: (stagePath: string) => Promise<void>;
}>;

export function createPdfImportStageStore(stageRootDir: string): PdfImportStageStore {
  function stageDirFor(stageId: string): string {
    assertSafeStageId(stageId);
    return resolveWithinDirectory(stageRootDir, stageId);
  }

  async function createStage(attemptId: string, bytes: Uint8Array): Promise<CreatedStage> {
    const stageDir = stageDirFor(attemptId);
    // Ensure the shared root exists, then create THIS attempt's directory EXCLUSIVELY (non-recursive
    // mkdir throws EEXIST if it already exists). A start that reuses an id therefore fails here instead
    // of overwriting a live attempt's staged bytes; `writeFile` with the `wx` flag is a second exclusive
    // guard on the staged file itself.
    await mkdir(stageRootDir, { recursive: true });
    await mkdir(stageDir);
    await writeFile(join(stageDir, STAGED_FILE_NAME), bytes, { flag: "wx" });
    return Object.freeze({
      stagePath: attemptId,
      handle: issueStagedFileHandle(stageDir, STAGED_FILE_NAME)
    });
  }

  async function createStageFromStream(
    attemptId: string,
    source: AsyncIterable<Uint8Array>,
    options: Readonly<{ maxBytes: number }>
  ): Promise<StreamedStage> {
    const stageDir = stageDirFor(attemptId);
    // Create THIS attempt's directory EXCLUSIVELY before streaming — an id collision throws here (EEXIST)
    // and must NOT trigger the cleanup below, so it can never remove a colliding attempt's staged bytes.
    await mkdir(stageRootDir, { recursive: true });
    await mkdir(stageDir);
    const filePath = join(stageDir, STAGED_FILE_NAME);
    const hash = createHash("sha256");
    let byteLength = 0;
    try {
      await pipeline(
        source,
        async function* boundHashingChunks(chunks: AsyncIterable<Uint8Array>) {
          for await (const chunk of chunks) {
            byteLength += chunk.byteLength;
            if (byteLength > options.maxBytes) {
              throw new PdfUploadTooLargeError(options.maxBytes);
            }
            hash.update(chunk);
            yield chunk;
          }
        },
        // `wx` is a second exclusive guard on the staged file itself.
        createWriteStream(filePath, { flags: "wx" })
      );
    } catch (cause) {
      // A failed stream (too large, aborted, or a write error) leaves no usable stage: remove only the
      // directory THIS call created so no partial bytes linger. The colliding-id case never reaches here.
      await rm(stageDir, { force: true, recursive: true });
      throw cause;
    }
    return Object.freeze({
      stagePath: attemptId,
      handle: issueStagedFileHandle(stageDir, STAGED_FILE_NAME),
      sha256: hash.digest("hex"),
      byteLength
    });
  }

  function openStage(stagePath: string): StagedFileHandle {
    return issueStagedFileHandle(stageDirFor(stagePath), STAGED_FILE_NAME);
  }

  async function writeDerivedStage(stagePath: string, bytes: Uint8Array): Promise<StagedFileHandle> {
    const stageDir = stageDirFor(stagePath);
    // `w` (not `wx`): a re-run of the OCR pass before adoption may legitimately overwrite an earlier,
    // unadopted derived file. The original `staged.pdf` in the same directory is never touched.
    await writeFile(join(stageDir, DERIVED_OCR_FILE_NAME), bytes, { flag: "w" });
    return issueStagedFileHandle(stageDir, DERIVED_OCR_FILE_NAME);
  }

  function openDerivedStage(stagePath: string): StagedFileHandle {
    return issueStagedFileHandle(stageDirFor(stagePath), DERIVED_OCR_FILE_NAME);
  }

  async function readStage(stagePath: string): Promise<Uint8Array> {
    const handle = openStage(stagePath);
    return new Uint8Array(await readFile(handle.path));
  }

  async function removeStage(stagePath: string): Promise<void> {
    await rm(stageDirFor(stagePath), { force: true, recursive: true });
  }

  return Object.freeze({
    createStage,
    createStageFromStream,
    openStage,
    writeDerivedStage,
    openDerivedStage,
    readStage,
    removeStage
  });
}
