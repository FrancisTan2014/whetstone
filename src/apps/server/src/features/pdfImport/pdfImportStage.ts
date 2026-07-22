import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { issueStagedFileHandle, type StagedFileHandle } from "../../files/pdfStructuredAdapter.js";
import { resolveWithinDirectory } from "../../files/sourceFileStore.js";

// The one attempt-owned staging lifecycle (#721). A PDF import owns its staged bytes in a per-attempt
// directory under a server-owned root, SEPARATE from immutable source provenance and from readable
// content. #701's adapter never sees a user path — it only reads through the server-issued
// `StagedFileHandle` this store mints. The store removes ONLY the exact attempt-owned directory it was
// told to; it never sweeps the root by age, so an unrelated file is never deleted (a cleanup failure is
// surfaced to the caller so it stays visible and retryable).

const STAGED_FILE_NAME = "staged.pdf";

// Server-generated attempt ids only (uuid-shaped): letters, digits, hyphen, underscore — never a path
// segment. Rejected before any filesystem touch so a crafted id cannot escape the stage root.
const safeStageIdPattern = /^[A-Za-z0-9_-]+$/;

function assertSafeStageId(stageId: string): void {
  if (!safeStageIdPattern.test(stageId)) {
    throw new Error("Stage id must contain only letters, digits, hyphen, or underscore.");
  }
}

export type CreatedStage = Readonly<{ stagePath: string; handle: StagedFileHandle }>;

export type PdfImportStageStore = Readonly<{
  // Create the attempt's secure stage: write the uploaded bytes into a fresh per-attempt directory and
  // return the relative stage path (persisted on the attempt) plus a server-issued handle #701 reads.
  // Creation is EXCLUSIVE: if a directory for this attempt id already exists (an id collision), it
  // throws instead of overwriting the existing attempt's staged bytes.
  createStage: (attemptId: string, bytes: Uint8Array) => Promise<CreatedStage>;
  // Re-open the handle for an already-created stage (e.g. a resumed run after restart), from the stored
  // relative stage path. Does not touch disk; the runner's read reports a missing stage as a failure.
  openStage: (stagePath: string) => StagedFileHandle;
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

  function openStage(stagePath: string): StagedFileHandle {
    return issueStagedFileHandle(stageDirFor(stagePath), STAGED_FILE_NAME);
  }

  async function readStage(stagePath: string): Promise<Uint8Array> {
    const handle = openStage(stagePath);
    return new Uint8Array(await readFile(handle.path));
  }

  async function removeStage(stagePath: string): Promise<void> {
    await rm(stageDirFor(stagePath), { force: true, recursive: true });
  }

  return Object.freeze({ createStage, openStage, readStage, removeStage });
}
