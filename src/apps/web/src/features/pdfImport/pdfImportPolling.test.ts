import type { PdfImportViewDto } from "@whetstone/contracts";
import { describe, expect, it, vi } from "vitest";

import { pollPdfImportUntilTerminal, type PdfImportPollDeps } from "./pdfImportPolling";

const sha = "b".repeat(64);

// Build a view whose projected progress is in flight (running, unprobed) or terminal (published), so the
// loop's control flow can be exercised without the progress projection under test here.
function runningView(): PdfImportViewDto {
  return {
    publication: { status: "pending" },
    review: null,
    status: {
      adapterFingerprint: null,
      attemptId: "attempt-1",
      completedPages: 0,
      completedRanges: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      failure: null,
      heartbeatAt: null,
      phase: null,
      sourceHash: sha,
      stage: { bound: true },
      state: "running",
      totalPages: null,
      totalRanges: null,
      updatedAt: "2026-01-01T00:00:00.000Z"
    }
  };
}

function publishedView(workEntryId: string): PdfImportViewDto {
  return {
    ...runningView(),
    publication: { status: "published", unresolvedFigureCount: 0, workEntryId }
  };
}

// A view whose execution was interrupted (a crash/restart abandoned the running claim, recovered at
// startup). The runner only advances `queued` attempts, so the poll loop must re-queue it via `resume`.
function interruptedView(): PdfImportViewDto {
  return { ...runningView(), status: { ...runningView().status, state: "interrupted" } };
}

function deps(
  fetchView: PdfImportPollDeps["fetchView"],
  resume: PdfImportPollDeps["resume"] = async () => null
): PdfImportPollDeps {
  return { delay: async () => undefined, fetchView, intervalMs: 5, resume };
}

describe("pollPdfImportUntilTerminal", () => {
  it("polls until a terminal outcome and reports every projected progress", async () => {
    const fetchView = vi
      .fn<(attemptId: string) => Promise<PdfImportViewDto | null>>()
      .mockResolvedValueOnce(runningView())
      .mockResolvedValueOnce(publishedView("work-7"));
    const onProgress = vi.fn();

    const result = await pollPdfImportUntilTerminal("attempt-1", onProgress, deps(fetchView));

    expect(result).toEqual({
      kind: "terminal",
      progress: expect.objectContaining({ kind: "published" })
    });
    // The in-flight poll and the terminal poll both reported.
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ kind: "in_progress" }));
  });

  it("stops with `gone` when the attempt no longer exists for this user", async () => {
    const fetchView = vi.fn(async () => null);

    const result = await pollPdfImportUntilTerminal("attempt-1", vi.fn(), deps(fetchView));

    expect(result).toEqual({ kind: "gone" });
  });

  it("aborts before the first poll when already signalled", async () => {
    const fetchView = vi.fn(async () => publishedView("work-1"));

    const result = await pollPdfImportUntilTerminal(
      "attempt-1",
      vi.fn(),
      deps(fetchView),
      () => true
    );

    expect(result).toEqual({ kind: "aborted" });
    expect(fetchView).not.toHaveBeenCalled();
  });

  it("aborts between polls once the caller signals, leaving the server job running", async () => {
    let aborted = false;
    const fetchView = vi.fn(async () => {
      // The first poll is in flight; signal an abort so the loop exits before the next fetch.
      aborted = true;
      return runningView();
    });

    const result = await pollPdfImportUntilTerminal(
      "attempt-1",
      vi.fn(),
      deps(fetchView),
      () => aborted
    );

    expect(result).toEqual({ kind: "aborted" });
    expect(fetchView).toHaveBeenCalledTimes(1);
  });

  it("defaults to never aborting when no signal is supplied", async () => {
    const fetchView = vi.fn(async () => publishedView("work-1"));

    const result = await pollPdfImportUntilTerminal("attempt-1", vi.fn(), deps(fetchView));

    expect(result.kind).toBe("terminal");
    expect(fetchView).toHaveBeenCalledTimes(1);
  });

  it("re-queues an interrupted attempt via `resume` so a recovered import resumes", async () => {
    // A crash/restart-recovered import polls as `interrupted` and stays there until it is re-queued.
    // The loop must call `resume` once; the retry moves it to a running state that then publishes. On the
    // pre-fix behaviour (no resume call) this hangs on `interrupted` forever and never reaches terminal.
    const fetchView = vi
      .fn<(attemptId: string) => Promise<PdfImportViewDto | null>>()
      .mockResolvedValueOnce(interruptedView())
      .mockResolvedValueOnce(runningView())
      .mockResolvedValueOnce(publishedView("work-3"));
    const resume = vi.fn(async () => runningView());
    const onProgress = vi.fn();

    const result = await pollPdfImportUntilTerminal(
      "attempt-2",
      onProgress,
      deps(fetchView, resume)
    );

    expect(result).toEqual({
      kind: "terminal",
      progress: expect.objectContaining({ kind: "published", workEntryId: "work-3" })
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("attempt-2");
    // The refreshed view returned by `resume` is reported too, so the card leaves the paused label at once.
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ needsResume: false }));
  });

  it("re-queues only once while an attempt stays interrupted", async () => {
    // Two consecutive interrupted polls must not fire two retries; the guard holds until the attempt
    // leaves the interrupted state.
    const fetchView = vi
      .fn<(attemptId: string) => Promise<PdfImportViewDto | null>>()
      .mockResolvedValueOnce(interruptedView())
      .mockResolvedValueOnce(interruptedView())
      .mockResolvedValueOnce(publishedView("work-4"));
    const resume = vi.fn(async () => interruptedView());

    const result = await pollPdfImportUntilTerminal("attempt-5", vi.fn(), deps(fetchView, resume));

    expect(result.kind).toBe("terminal");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("stops with `gone` when the interrupted attempt vanishes on resume", async () => {
    const fetchView = vi.fn(async () => interruptedView());
    const resume = vi.fn(async () => null);

    const result = await pollPdfImportUntilTerminal("attempt-6", vi.fn(), deps(fetchView, resume));

    expect(result).toEqual({ kind: "gone" });
    expect(resume).toHaveBeenCalledTimes(1);
  });
});
