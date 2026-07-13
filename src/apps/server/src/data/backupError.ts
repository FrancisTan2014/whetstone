// A backup/restore failure carries what happened plus the exact safe remedy, so the CLI can fail
// loudly with an actionable message instead of a bare stack trace (issue #600). Never swallow one
// into a success-shaped fallback.
export class BackupError extends Error {
  override readonly name = "BackupError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}
