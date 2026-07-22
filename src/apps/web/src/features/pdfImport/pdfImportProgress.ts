import type { PdfImportViewDto } from "@whetstone/contracts";

// The exact sequenced-limitation phrase the acceptance requires the UI to show for a scanned/mixed PDF
// (#702): OCR is #704, so the import refuses rather than fabricating empty blocks. Kept as a named export
// so the Library flow and its tests share one source of truth.
export const ocrSupportUnavailableMessage = "OCR support is not available yet.";

// The learner-facing phrase for a PDF that converted but carried no readable content (#702): the import
// refuses rather than creating an empty-shell Work. A named export so the flow and its tests agree.
export const noReadableContentMessage =
  "This PDF has no readable text content to import, so no book was created.";

function ocrRequiredMessage(pagesNeedingOcr: number): string {
  const pages = pagesNeedingOcr === 1 ? "1 page needs" : `${pagesNeedingOcr} pages need`;
  return `${ocrSupportUnavailableMessage} ${pages} text recognition, which a later update will add.`;
}

// The learner-facing progress model derived from one poll of an import's view. `in_progress` carries the
// label to show while polling continues; the terminal kinds end the poll loop and drive navigation
// or a message. Keeping this a pure projection means the Library flow only wires timers and navigation,
// and every phrase/branch is unit-tested without a component or the network.
export type PdfImportProgress =
  | Readonly<{ kind: "in_progress"; label: string; terminal: false }>
  | Readonly<{ kind: "published"; workEntryId: string; terminal: true }>
  | Readonly<{ kind: "ocr_required"; message: string; terminal: true }>
  | Readonly<{ kind: "no_content"; message: string; terminal: true }>
  | Readonly<{ kind: "failed"; message: string; terminal: true }>;

// Project an import view into its progress model. Terminal outcomes win over in-flight labels: a published
// Work (open the Reader), an OCR-required refusal (no Work; sequenced-limitation copy), a no-content
// refusal (no Work; empty-document copy), or a failed conversion (the adapter's named failure). Otherwise
// the label reflects the #721 execution phase — reading the source, converting a known page range,
// resuming after an interruption, or finishing publication.
export function describePdfImport(view: PdfImportViewDto): PdfImportProgress {
  if (view.publication.status === "published") {
    return { kind: "published", terminal: true, workEntryId: view.publication.workEntryId };
  }

  if (view.publication.status === "ocr_required") {
    return {
      kind: "ocr_required",
      message: ocrRequiredMessage(view.publication.pagesNeedingOcr),
      terminal: true
    };
  }

  if (view.publication.status === "no_content") {
    return { kind: "no_content", message: noReadableContentMessage, terminal: true };
  }

  if (view.status.state === "failed") {
    return {
      kind: "failed",
      message:
        view.status.failure?.message ?? "The import could not be completed. Please try again.",
      terminal: true
    };
  }

  return { kind: "in_progress", label: inProgressLabel(view), terminal: false };
}

function inProgressLabel(view: PdfImportViewDto): string {
  const { completedPages, state, totalPages } = view.status;

  if (state === "interrupted") {
    return "Import paused — resuming…";
  }

  if (state === "converted") {
    return "Finishing up…";
  }

  if (state === "queued") {
    return "Queued for import…";
  }

  // Running: before the source is probed there is no page total; after, report concrete page progress
  // (never a percentage parsed from a subprocess).
  if (totalPages === null) {
    return "Reading the PDF…";
  }

  return `Converting page ${Math.min(completedPages + 1, totalPages)} of ${totalPages}…`;
}
