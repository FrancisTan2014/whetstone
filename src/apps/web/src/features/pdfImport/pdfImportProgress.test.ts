import type {
  PdfImportPublicationOutcomeDto,
  PdfImportStatusDto,
  PdfImportViewDto,
  WorkCreationReviewDto
} from "@whetstone/contracts";
import { describe, expect, it } from "vitest";

import {
  describePdfImport,
  noReadableContentMessage,
  ocrValidationFailedMessage,
  recognizingTextLabel
} from "./pdfImportProgress";

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
    phase: null,
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
  return { publication, review: null, status: status(statusOverrides) };
}

describe("describePdfImport", () => {
  it("reports a published Work so the caller can open the Reader", () => {
    const progress = describePdfImport(view({ status: "published", workEntryId: "work-9" }));

    expect(progress).toEqual({ kind: "published", terminal: true, workEntryId: "work-9" });
  });

  it("refuses a single validation-failed page with the recognition-failed copy", () => {
    const progress = describePdfImport(
      view({ pagesNeedingOcr: 1, status: "ocr_validation_failed" })
    );

    expect(progress.kind).toBe("ocr_validation_failed");
    expect(progress.terminal).toBe(true);
    if (progress.kind === "ocr_validation_failed") {
      expect(progress.message).toContain(ocrValidationFailedMessage);
      expect(progress.message).toContain("1 page");
    }
  });

  it("pluralizes when several pages fail OCR validation", () => {
    const progress = describePdfImport(
      view({ pagesNeedingOcr: 4, status: "ocr_validation_failed" })
    );

    if (progress.kind === "ocr_validation_failed") {
      expect(progress.message).toContain("4 pages");
    } else {
      expect.unreachable("expected ocr_validation_failed");
    }
  });

  it("refuses a no-content PDF with the empty-document copy", () => {
    const progress = describePdfImport(view({ status: "no_content" }));

    expect(progress).toEqual({
      kind: "no_content",
      message: noReadableContentMessage,
      terminal: true
    });
  });

  it("refuses a single unpreservable image with the singular copy", () => {
    const progress = describePdfImport(
      view({ status: "image_unsupported", unpreservableImages: 1 })
    );

    expect(progress.kind).toBe("image_unsupported");
    expect(progress.terminal).toBe(true);
    if (progress.kind === "image_unsupported") {
      expect(progress.message).toContain("an image that cannot");
    } else {
      expect.unreachable("expected image_unsupported");
    }
  });

  it("pluralizes when several images cannot be preserved", () => {
    const progress = describePdfImport(
      view({ status: "image_unsupported", unpreservableImages: 4 })
    );

    if (progress.kind === "image_unsupported") {
      expect(progress.message).toContain("4 images that cannot");
    } else {
      expect.unreachable("expected image_unsupported");
    }
  });

  it("surfaces the adapter's named failure message", () => {
    const progress = describePdfImport(
      view(
        { status: "pending" },
        {
          failure: {
            kind: "unreadable",
            message: "The converter could not read this PDF.",
            remedy: "Try another file."
          },
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
    const progress = describePdfImport(
      view({ status: "pending" }, { failure: null, state: "failed" })
    );

    if (progress.kind === "failed") {
      expect(progress.message).toBe("The import could not be completed. Please try again.");
    } else {
      expect.unreachable("expected failed");
    }
  });

  it("labels a queued attempt", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "queued" }));

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Queued for import…",
      needsResume: false,
      terminal: false
    });
  });

  it("flags an interrupted attempt for resume so the poll loop re-queues it", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "interrupted" }));

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Import paused — resuming…",
      needsResume: true,
      terminal: false
    });
  });

  it("labels a converted attempt as finishing up", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "converted" }));

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Finishing up…",
      needsResume: false,
      terminal: false
    });
  });

  it("hands a minted review to the shared panel and stops polling once the attempt is parked", () => {
    const reviewDto: WorkCreationReviewDto = {
      attemptId: "attempt-1",
      candidateFingerprint: "fp-1",
      candidates: [],
      proposed: {
        authorName: "Marcus Aurelius",
        language: "en",
        title: "Meditations",
        workType: "book"
      },
      revision: 0,
      sourceFileName: "meditations.pdf"
    };
    const parked: PdfImportViewDto = {
      publication: { status: "pending" },
      review: reviewDto,
      status: status({ state: "awaiting_review" })
    };

    const progress = describePdfImport(parked);

    expect(progress).toEqual({ kind: "needs_review", review: reviewDto, terminal: true });
  });

  it("keeps polling with a neutral duplicate-check label while the review has not been minted yet", () => {
    const progress = describePdfImport(view({ status: "pending" }, { state: "awaiting_review" }));

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Checking your library for duplicates…",
      needsResume: false,
      terminal: false
    });
  });

  it("labels the durable OCR phase while text is recognized", () => {
    const progress = describePdfImport(
      view({ status: "pending" }, { phase: "ocr", state: "running", totalPages: null })
    );

    expect(progress).toEqual({
      kind: "in_progress",
      label: recognizingTextLabel,
      needsResume: false,
      terminal: false
    });
  });

  it("labels a running attempt before the source is probed", () => {
    const progress = describePdfImport(
      view({ status: "pending" }, { state: "running", totalPages: null })
    );

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Reading the PDF…",
      needsResume: false,
      terminal: false
    });
  });

  it("reports concrete page progress once the source has been probed", () => {
    const progress = describePdfImport(
      view({ status: "pending" }, { completedPages: 4, state: "running", totalPages: 10 })
    );

    expect(progress).toEqual({
      kind: "in_progress",
      label: "Converting page 5 of 10…",
      needsResume: false,
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
