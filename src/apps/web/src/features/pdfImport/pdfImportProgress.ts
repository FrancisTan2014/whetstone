import type { PdfImportViewDto, WorkCreationReviewDto } from "@whetstone/contracts";

// The learner-facing phrase for a PDF that still had text-less pages after the OCR pass (#745/#746): a
// preflight/full-conversion disagreement or incomplete recognition, so the import refuses rather than
// publishing a partial Work. A named export so the flow and its tests agree.
export const ocrValidationFailedMessage =
  "Some pages could not be read even after text recognition, so no book was created.";

// The learner-facing phrase for a PDF that converted but carried no readable content (#702): the import
// refuses rather than creating an empty-shell Work. A named export so the flow and its tests agree.
export const noReadableContentMessage =
  "This PDF has no readable text content to import, so no book was created.";

// The progress label shown while the durable OCR phase (#745/#746) runs — text is being recognized from
// scanned/mixed pages before structured conversion. Language-neutral because OCR now runs for every Work
// language (#746), not English alone. A named export so the flow and its tests agree.
export const recognizingTextLabel = "Recognizing text…";

// The learner-facing phrase for a PDF that published with one or more unresolved figure placeholders
// (#806): the readable text is imported, but each figure still needs an administrator to supply its image
// in the shared Work editor. A named export so the Library flow and its tests agree, and pluralized so a
// larger count reads naturally.
export function figuresToReviewMessage(figuresToReview: number): string {
  const figures = figuresToReview === 1 ? "1 figure" : `${figuresToReview} figures`;
  return `Imported with ${figures} to review.`;
}

// The learner-facing phrase for a PDF whose heading depths came from labels rather than the embedded
// outline (#870). `label` is the count of headings derived from labels (the gap); `outline` is the count
// derived from the outline. The message distinguishes a book with no outline at all from a book whose
// outline was present but only partially matched. A named export so the Library flow and its tests agree.
export function outlineGapMessage(label: number, outline: number): string {
  const headings = label === 1 ? "1 heading" : `${label} headings`;
  if (outline === 0) {
    return `Imported with ${headings} from labels (no outline).`;
  }
  return `Imported with ${headings} from labels (outline present; some headings unmatched).`;
}

function imageUnsupportedMessage(unpreservableImages: number): string {
  const images =
    unpreservableImages === 1
      ? "an image that cannot"
      : `${unpreservableImages} images that cannot`;
  return `This PDF contains ${images} be preserved yet, so no book was created.`;
}

function ocrValidationFailedPagesMessage(pagesNeedingOcr: number): string {
  const pages = pagesNeedingOcr === 1 ? "1 page" : `${pagesNeedingOcr} pages`;
  return `${ocrValidationFailedMessage} ${pages} still had no readable text after recognition.`;
}

// The learner-facing progress model derived from one poll of an import's view. `in_progress` carries the
// label to show while polling continues; the terminal kinds end the poll loop and drive navigation
// or a message. Keeping this a pure projection means the Library flow only wires timers and navigation,
// and every phrase/branch is unit-tested without a component or the network.
export type PdfImportProgress =
  | Readonly<{ kind: "in_progress"; label: string; needsResume: boolean; terminal: false }>
  | Readonly<{
      kind: "published";
      workEntryId: string;
      figuresToReview: number;
      // Outline-gap warning (#870): heading depths from labels (the gap) and from the outline.
      headingLevelSources: Readonly<{ label: number; outline: number }>;
      terminal: true;
    }>
  | Readonly<{ kind: "needs_review"; review: WorkCreationReviewDto; terminal: true }>
  | Readonly<{ kind: "ocr_validation_failed"; message: string; terminal: true }>
  | Readonly<{ kind: "no_content"; message: string; terminal: true }>
  | Readonly<{ kind: "image_unsupported"; message: string; terminal: true }>
  | Readonly<{ kind: "failed"; message: string; terminal: true }>;

// Project an import view into its progress model. Terminal outcomes win over in-flight labels: a published
// Work (open the Reader), a validation-failed refusal (no Work; pages still text-less after OCR), a
// no-content refusal (no Work; empty-document copy), an unsupported-image refusal (no Work;
// unpreservable-image copy), or a failed conversion (the adapter's named failure). Otherwise the label
// reflects the #721/#745 execution phase — recognizing text during OCR, reading the source, converting a
// known page range, resuming after an interruption, or finishing publication. An `interrupted` attempt (a
// run abandoned by a crash/restart and recovered at startup) is flagged `needsResume`: the runner only
// picks up `queued`, so the poll loop must re-queue it via the retry API — otherwise the import sits
// paused forever.
export function describePdfImport(view: PdfImportViewDto): PdfImportProgress {
  if (view.publication.status === "published") {
    return {
      figuresToReview: view.publication.unresolvedFigureCount,
      headingLevelSources: view.publication.headingLevelSources,
      kind: "published",
      terminal: true,
      workEntryId: view.publication.workEntryId
    };
  }

  if (view.publication.status === "ocr_validation_failed") {
    return {
      kind: "ocr_validation_failed",
      message: ocrValidationFailedPagesMessage(view.publication.pagesNeedingOcr),
      terminal: true
    };
  }

  if (view.publication.status === "no_content") {
    return { kind: "no_content", message: noReadableContentMessage, terminal: true };
  }

  if (view.publication.status === "image_unsupported") {
    return {
      kind: "image_unsupported",
      message: imageUnsupportedMessage(view.publication.unpreservableImages),
      terminal: true
    };
  }

  if (view.status.state === "failed") {
    return {
      kind: "failed",
      message:
        view.status.failure?.message ?? "The import could not be completed. Please try again.",
      terminal: true
    };
  }

  // A converted attempt parked at the shared duplicate-review boundary (#750): once the first poll after
  // conversion has minted the review, hand it to the shared review panel and stop polling. Until the review
  // exists (the parking poll, or a transient re-check), keep polling with a neutral "checking" label — an
  // immediate create/reopen/refusal resolves through the publication field above instead.
  if (view.status.state === "awaiting_review" && view.review !== null) {
    return { kind: "needs_review", review: view.review, terminal: true };
  }

  return {
    kind: "in_progress",
    label: inProgressLabel(view),
    needsResume: view.status.state === "interrupted",
    terminal: false
  };
}

function inProgressLabel(view: PdfImportViewDto): string {
  const { completedPages, phase, state, totalPages } = view.status;

  if (state === "interrupted") {
    return "Import paused — resuming…";
  }

  if (state === "converted") {
    return "Finishing up…";
  }

  // The converted attempt is at the duplicate-review boundary but its review has not been minted yet (the
  // parking poll, or a transient re-check): show a neutral checking label rather than a stale phase.
  if (state === "awaiting_review") {
    return "Checking your library for duplicates…";
  }

  if (state === "queued") {
    return "Queued for import…";
  }

  // The durable OCR phase runs before structured conversion; surface it distinctly so a scanned/mixed
  // import shows recognition progress rather than a misleading "converting" label.
  if (phase === "ocr") {
    return recognizingTextLabel;
  }

  // Running: before the source is probed there is no page total; after, report concrete page progress
  // (never a percentage parsed from a subprocess).
  if (totalPages === null) {
    return "Reading the PDF…";
  }

  return `Converting page ${Math.min(completedPages + 1, totalPages)} of ${totalPages}…`;
}
