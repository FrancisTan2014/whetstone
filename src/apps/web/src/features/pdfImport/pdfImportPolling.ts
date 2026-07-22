import type { PdfImportViewDto } from "@whetstone/contracts";

import { describePdfImport, type PdfImportProgress } from "./pdfImportProgress";

// Injected seams so the poll loop is unit-testable without the network or real timers, and so navigation
// away can abort it. The Library passes the real `fetchPdfImportView` and a `setTimeout`-backed delay.
export type PdfImportPollDeps = Readonly<{
  fetchView: (attemptId: string) => Promise<PdfImportViewDto | null>;
  delay: (ms: number) => Promise<void>;
  intervalMs: number;
}>;

// Why a poll stopped: a terminal progress model (published / ocr_required / failed), `gone` when the
// attempt no longer exists for this user (a stale reopened id — drop it), or `aborted` when the caller
// signalled to stop (navigation/unmount) before a terminal state.
export type PdfImportPollResult =
  | Readonly<{ kind: "terminal"; progress: PdfImportProgress }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "aborted" }>;

// Poll one import's view until it reaches a terminal outcome, is gone, or the caller aborts. Every poll
// (including the first, immediate one) reports its projected progress via `onProgress` so the UI updates
// without waiting a full interval. The server job keeps running regardless of this loop, so aborting only
// stops the local polling — the import still completes and can be reopened later.
export async function pollPdfImportUntilTerminal(
  attemptId: string,
  onProgress: (progress: PdfImportProgress) => void,
  deps: PdfImportPollDeps,
  isAborted: () => boolean = () => false
): Promise<PdfImportPollResult> {
  for (;;) {
    if (isAborted()) {
      return { kind: "aborted" };
    }

    const view = await deps.fetchView(attemptId);
    if (view === null) {
      return { kind: "gone" };
    }

    const progress = describePdfImport(view);
    onProgress(progress);

    if (progress.terminal) {
      return { kind: "terminal", progress };
    }

    await deps.delay(deps.intervalMs);
  }
}
