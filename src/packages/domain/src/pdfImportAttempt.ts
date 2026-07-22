// The lifecycle of one recoverable staged PDF import attempt (#721). Import EXECUTION state lives here,
// entirely separate from readable content: an attempt owns staged bytes, a bounded conversion run, and
// its per-range checkpoints, but it never becomes a Work, ReadingUnit, or Block. Publication (#702) is a
// different owner. This module is pure — no DB, fs, or child process — so every transition, fence, and
// resume decision is decided by a total function the store and runner can trust.
//
// States:
//   - `queued`      — created and staged, waiting for the single conversion slot.
//   - `running`     — a claim holds the conversion slot under a run token; a child may be converting.
//   - `converted`   — every structured range passed #701 validation. Terminal. Creates no content.
//   - `failed`      — a typed conversion failure. Terminal, but retryable back to `queued`.
//   - `cancelled`   — the owner cancelled; the child was fenced and stages removed. Terminal, retryable.
//   - `interrupted` — a claim was abandoned (the process died mid-run) and recovered at startup.
//                     Non-terminal and explicitly retryable; never silently resumed as `running`.

export const pdfImportAttemptStates = [
  "queued",
  "running",
  "converted",
  "failed",
  "cancelled",
  "interrupted"
] as const;

export type PdfImportAttemptState = (typeof pdfImportAttemptStates)[number];

// Terminal outcomes never re-run and are never cancelled. `converted` is success; `failed`/`cancelled`
// have already had their stage removed, so there is nothing to resume — the consumer starts a fresh
// import. A non-terminal attempt (`queued`, `running`, `interrupted`) is the exact set an owner may
// cancel, so the store consults this predicate instead of duplicating the state set.
const terminalStates: ReadonlySet<PdfImportAttemptState> = new Set([
  "converted",
  "failed",
  "cancelled"
]);

export function isNonTerminalAttemptState(state: PdfImportAttemptState): boolean {
  return !terminalStates.has(state);
}

// The terminal outcomes (`converted`, `failed`, `cancelled`): the run is over and any stage the attempt
// still owns is leftover cleanup, not live input. A cleanup-retry consults this so it only ever removes a
// stage from an attempt that is truly done — never a `queued`/`running`/`interrupted` attempt whose bytes
// are still needed to convert or resume.
export function isTerminalAttemptState(state: PdfImportAttemptState): boolean {
  return terminalStates.has(state);
}

// The only retryable state is `interrupted`: a running claim abandoned by a dead process, whose stage
// and committed ranges are still intact on disk, so the run can resume after the last committed range.
// `running` holds the live slot; terminal states have no stage to resume. Retry of any other state is
// rejected, not a silent no-op.
export function isRetryableAttemptState(state: PdfImportAttemptState): boolean {
  return state === "interrupted";
}

// A late range output or checkpoint may be applied only while the SAME claim still holds the slot: the
// attempt is still `running` and its run token matches the token the child was started under. A
// cancellation, restart, or interrupt clears/replaces the token or leaves `running`, so a stale child's
// write is fenced out here before it can persist a checkpoint.
export function mayApplyRunOutput(
  attempt: Readonly<{ state: PdfImportAttemptState; runToken: string | null }>,
  runToken: string
): boolean {
  return attempt.state === "running" && attempt.runToken !== null && attempt.runToken === runToken;
}

// The first range index (0-based) not yet committed, i.e. where a resumed run continues. Committed
// ranges are already validated and idempotent, so a retry never re-converts them. A gap (a missing
// earlier range) resumes at the gap, never past it, so no range is skipped.
export function nextRangeIndex(
  committedRangeIndices: Iterable<number>,
  totalRanges: number
): number {
  const committed = new Set(committedRangeIndices);
  for (let index = 0; index < totalRanges; index += 1) {
    if (!committed.has(index)) {
      return index;
    }
  }
  return totalRanges;
}
