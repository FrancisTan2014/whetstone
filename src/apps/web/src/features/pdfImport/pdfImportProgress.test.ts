import type {
  PdfImportPublicationOutcomeDto,
  PdfImportStatusDto,
  PdfImportViewDto
} from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import { describePdfImport, ocrSupportUnavailableMessage } from "./pdfImportProgress";

const sha = "a".repeat(64);

// A running status with no probe yet; overrides tailor the specific branch under test.
function status(overrides: Partial<PdfImportStatusDto> = {}): PdfImportStatusDto {
  return {
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
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function view(
  publication: PdfImportPublicationOutcomeDto,
  statusOverrides: Partial<PdfImportStatusDto> = {}
): PdfImportViewDto {
  return { publication, status: status(statusOverrides) };
}

describe("describePdfImport", () => {
  it("reports a published Work so the caller can open the Reader", () => {
    const progress = describePdfImport(view({ status: "published", workEntryId: "work-9" }));

    expect(progress).toEqual({ kind: "published", terminal: true, workEntryId: "work-9" });
  });

  it("refuses a single OCR-needing page with the sequenced-limitation copy", () => {
    const progress = describePdfImport(view({ pagesNeedingOcr: 1, status: "ocr_required" }));

    expect(progress.kind).toBe("ocr_required");
    expect(progress.terminal).toBe(true);
    if (progress.kind === "ocr_required") {
      expect(progress.message).toContain(ocrSupportUnavailableMessage);
      expect(progress.message).toContain("1 page needs");
    }
  });

  it("pluralizes when several pages need OCR", () => {
    const progress = describePdfImport(view({ pagesNeedingOcr: 3, status: "ocr_required" }));

    if (progress.kind === "ocr_required") {
      expect(progress.message).toContain("3 pages need");
    } else {
      expect.unreachable("expected ocr_required");
    }
  });

  it("surfaces the adapter's named failure message", () => {
    const progress = describePdfImport(
      view(
        { status: "pending" },
        {
          failure: { kind: "unreadable", message: "The converter could not read this PDF.", remedy: "Try another file." },
          state: "failed"
        }
      )
    );

    expect(progress).toEqual({
      kind: "failed",
      message: "The converter could not read this PDF.",
      terminal: true
    });
  });

  it("falls back to a generic failure message when the failure detail is absent", () => {
    const progress = describePdfImport(view({ status: "pending" }, { failure: null, state: "failed" }));

    if (progress.kind === "failed") {
      expect(progress.message).toBe("The import could not be completed. Please try again.");
    } else {
      expect.unreachable("expected failed");
    }
  });

  it("labels a queued attempt", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "queued" }));

    expect(progress).toEqual({ kind: "in_progress", label: "Queued for import…", terminal: false });
  });

  it("labels an interrupted attempt as paused/resuming", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "interrupted" }));

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Import paused — resuming…",
      terminal: false
    });
  });

  it("labels a converted attempt as finishing up", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "converted" }));

    expect(progress).toEqual({ kind: "in_progress", label: "Finishing up…", terminal: false });
  });

  it("labels a running attempt before the source is probed", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "running", totalPages: null }));

    expect(progress).toEqual({ kind: "in_progress", label: "Reading the PDF…", terminal: false });
  });

  it("reports concrete page progress once the source has been probed", () => {
    const progress = describePdfImport(
      view({ status: "pending" }, { completedPages: 4, state: "running", totalPages: 10 })
    );

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Converting page 5 of 10…",
      terminal: false
    });
  });

  it("clamps the reported page to the total on the final range", () => {
    const progress = describePdfImport(
      view({ status: "pending" }, { completedPages: 10, state: "running", totalPages: 10 })
    );

    if (progress.kind === "in_progress") {
      expect(progress.label).toBe("Converting page 10 of 10…");
    } else {
      expect.unreachable("expected in_progress");
    }
  });
});
