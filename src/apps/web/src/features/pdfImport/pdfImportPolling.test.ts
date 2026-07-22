import type { PdfImportViewDto } from "@whetstone/contracts";
import { describe, expect, it, vi } from "vitest";

import { pollPdfImportUntilTerminal, type PdfImportPollDeps } from "./pdfImportPolling";

const sha = "b".repeat(64);

// Build a view whose projected progress is in flight (running, unprobed) or terminal (published), so the
// loop's control flow can be exercised without the progress projection under test here.
function runningView(): PdfImportViewDto {
  return {
    publication: { status: "pending" },
    status: {
      adapterFingerprint: null,
      attemptId: "attempt-1",
      completedPages: 0,
      completedRanges: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      failure: null,
      heartbeatAt: null,
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
  return { ...runningView(), publication: { status: "published", workEntryId } };
}

function deps(fetchView: PdfImportPollDeps["fetchView"]): PdfImportPollDeps {
  return { delay: async () => undefined, fetchView, intervalMs: 5 };
}

describe("pollPdfImportUntilTerminal", () => {
  it("polls until a terminal outcome and reports every projected progress", async () => {
    const fetchView = vi
      .fn<(attemptId: string) => Promise<PdfImportViewDto | null>>()
      .mockResolvedValueOnce(runningView())
      .mockResolvedValueOnce(publishedView("work-7"));
    const onProgress = vi.fn();

    const result = await pollPdfImportUntilTerminal("attempt-1", onProgress, deps(fetchView));

    expect(result).toEqual({ kind: "terminal", progress: expect.objectContaining({ kind: "published" }) });
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

    const result = await pollPdfImportUntilTerminal("attempt-1", vi.fn(), deps(fetchView), () => true);

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

    const result = await pollPdfImportUntilTerminal("attempt-1", vi.fn(), deps(fetchView), () => aborted);

    expect(result).toEqual({ kind: "aborted" });
    expect(fetchView).toHaveBeenCalledTimes(1);
  });

  it("defaults to never aborting when no signal is supplied", async () => {
    const fetchView = vi.fn(async () => publishedView("work-1"));

    const result = await pollPdfImportUntilTerminal("attempt-1", vi.fn(), deps(fetchView));

    expect(result.kind).toBe("terminal");
    expect(fetchView).toHaveBeenCalledTimes(1);
  });
});
