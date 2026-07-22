// The one in-flight born-digital PDF import a learner has going, remembered across navigation and reloads
// so the Library can reopen its status (#702). Only the opaque attempt id is stored; the durable job and
// all its state live server-side (#721), so losing this key never loses the import — it only hides the
// live progress card until the next successful start. Storage failures (private mode, disabled storage)
// degrade to "no remembered import" rather than throwing into the upload flow.

const storageKey = "whetstone.pdfImport.active";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberActivePdfImport(attemptId: string): void {
  try {
    storage()?.setItem(storageKey, attemptId);
  } catch {
    // A full or unavailable store just means the progress card won't reopen after a reload — the
    // server-side import is unaffected.
  }
}

export function readActivePdfImport(): string | null {
  try {
    const value = storage()?.getItem(storageKey);
    return value !== null && value !== undefined && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function forgetActivePdfImport(): void {
  try {
    storage()?.removeItem(storageKey);
  } catch {
    // Ignore: a stale key is harmless — a dead attempt id polls once, returns 404, and is dropped.
  }
}
