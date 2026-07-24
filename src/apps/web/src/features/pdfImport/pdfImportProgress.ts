import type { PdfImportViewDto } from "@whetstone/contracts";

// The learner-facing phrase for a scanned/mixed PDF whose language OCR is not enabled yet (#745): only
// English OCR runs today, so a text-less document in another language (Chinese until #746) is refused
// rather than published empty. A named export so the Library flow and its tests share one source of truth.
export const ocrLanguageNotEnabledMessage =
  "This PDF needs text recognition for a language that isn't enabled yet, so no book was created.";

// The learner-facing phrase for an English PDF that still had text-less pages after the OCR pass (#745):
// a preflight/full-conversion disagreement or incomplete recognition, so the import refuses rather than
// publishing a partial Work. A named export so the flow and its tests agree.
export const ocrValidationFailedMessage =
  "Some pages could not be read even after text recognition, so no book was created.";

// The learner-facing phrase for a PDF that converted but carried no readable content (#702): the import
// refuses rather than creating an empty-shell Work. A named export so the flow and its tests agree.
export const noReadableContentMessage =
  "This PDF has no readable text content to import, so no book was created.";

// The progress label shown while the durable OCR phase (#745) runs — English text is being recovered
// from scanned/mixed pages before structured conversion. A named export so the flow and its tests agree.
export const addingEnglishTextLabel = "Adding English text…";

function imageUnsupportedMessage(unpreservableImages: number): string {
  const images =
    unpreservableImages === 1
      ? "an image that cannot"
      : `${unpreservableImages} images that cannot`;
  return `This PDF contains ${images} be preserved yet, so no book was created.`;
}

function ocrLanguageNotEnabledPagesMessage(pagesNeedingOcr: number): string {
  const pages = pagesNeedingOcr === 1 ? "1 page needs" : `${pagesNeedingOcr} pages need`;
  return `${ocrLanguageNotEnabledMessage} ${pages} text recognition in a language a later update will add.`;
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
  | Readonly<{ kind: "published"; workEntryId: string; terminal: true }>
  | Readonly<{ kind: "ocr_language_not_enabled"; message: string; terminal: true }>
  | Readonly<{ kind: "ocr_validation_failed"; message: string; terminal: true }>
  | Readonly<{ kind: "no_content"; message: string; terminal: true }>
  | Readonly<{ kind: "image_unsupported"; message: string; terminal: true }>
  | Readonly<{ kind: "failed"; message: string; terminal: true }>;

// Project an import view into its progress model. Terminal outcomes win over in-flight labels: a published
// Work (open the Reader), a language-not-enabled refusal (no Work; the language is not OCR-enabled yet), a
// validation-failed refusal (no Work; English pages still text-less after OCR), a no-content refusal (no
// Work; empty-document copy), an unsupported-image refusal (no Work; unpreservable-image copy), or a
// failed conversion (the adapter's named failure). Otherwise the label reflects the #721/#745 execution
// phase — recovering English text during OCR, reading the source, converting a known page range, resuming
// after an interruption, or finishing publication. An `interrupted` attempt (a run abandoned by a
// crash/restart and recovered at startup) is flagged `needsResume`: the runner only picks up `queued`, so
// the poll loop must re-queue it via the retry API — otherwise the import sits paused forever.
export function describePdfImport(view: PdfImportViewDto): PdfImportProgress {
  if (view.publication.status === "published") {
    return { kind: "published", terminal: true, workEntryId: view.publication.workEntryId };
  }

  if (view.publication.status === "ocr_language_not_enabled") {
    return {
      kind: "ocr_language_not_enabled",
      message: ocrLanguageNotEnabledPagesMessage(view.publication.pagesNeedingOcr),
      terminal: true
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

  if (state === "queued") {
    return "Queued for import…";
  }

  // The durable OCR phase runs before structured conversion; surface it distinctly so a scanned/mixed
  // English import shows recognition progress rather than a misleading "converting" label.
  if (phase === "ocr") {
    return addingEnglishTextLabel;
  }

  // Running: before the source is probed there is no page total; after, report concrete page progress
  // (never a percentage parsed from a subprocess).
  if (totalPages === null) {
    return "Reading the PDF…";
  }

  return `Converting page ${Math.min(completedPages + 1, totalPages)} of ${totalPages}…`;
}
