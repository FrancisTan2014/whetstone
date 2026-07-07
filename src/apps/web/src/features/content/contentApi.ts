import type {
  IngestMarkdownRequest,
  ReadingUnitContentDto,
  WorkContentDto,
  WorkListDto,
  WorkStructureDto
} from "@whetstone/contracts";
import { pdfContentType } from "@whetstone/contracts";

import { apiUrl } from "../../shared/runtime";

const jsonHeaders = { "content-type": "application/json" } as const;

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

// The content feature keeps its own works fetch so it stays decoupled from the
// library admin feature.
export async function fetchWorks(): Promise<WorkListDto> {
  return requestJson<WorkListDto>(apiUrl("/works"));
}

// The authoring panel needs a work's whole content. It is now assembled from the lightweight
// structure plus each reading unit's blocks fetched on demand, so the server no longer ships a
// dedicated whole-work content route. A reading unit's content DTO is structurally a reading
// unit, so the composed result is a `WorkContentDto`.
export async function fetchWorkContent(workEntryId: string): Promise<WorkContentDto> {
  const structure = await requestJson<WorkStructureDto>(
    apiUrl(`/works/${encodeURIComponent(workEntryId)}/structure`)
  );
  const readingUnits = await Promise.all(
    structure.readingUnits.map((unit) =>
      requestJson<ReadingUnitContentDto>(
        apiUrl(
          `/works/${encodeURIComponent(workEntryId)}/units/${encodeURIComponent(
            unit.entryId
          )}/content`
        )
      )
    )
  );

  return { readingUnits, workEntryId: structure.workEntryId };
}

// Ingesting Markdown yields the work's new content, unless the Markdown has no readable blocks
// (e.g. image-only input — v0 has no image block), which the server reports as 422 `empty_content`
// so the panel can show an explicit unsupported-content message instead of a false success.
export type IngestMarkdownOutcome =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "empty_content" }>;

export async function ingestMarkdown(
  workEntryId: string,
  source: IngestMarkdownRequest
): Promise<IngestMarkdownOutcome> {
  const path = apiUrl(`/works/${encodeURIComponent(workEntryId)}/content`);
  const response = await fetch(path, {
    body: JSON.stringify(source),
    headers: jsonHeaders,
    method: "POST"
  });

  if (response.status === 422) {
    return { status: "empty_content" };
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return { content: (await response.json()) as WorkContentDto, status: "ingested" };
}

// Ingesting a PDF hands its raw bytes to the server's doc-AI worker, which converts it into the same
// block pipeline as a .md upload. It can fail three distinct ways the panel messages differently: the
// worker could not read the PDF (422 `invalid_pdf`), it produced no readable blocks (422
// `empty_content`), or the host's PDF toolchain is not installed (503 `pdf_toolchain_missing`, a
// provisioning gap — not a bad file). The 422s are distinguished by the response body's `error`.
export type IngestPdfOutcome =
  | Readonly<{ content: WorkContentDto; status: "ingested" }>
  | Readonly<{ status: "invalid_pdf" }>
  | Readonly<{ status: "pdf_toolchain_missing" }>
  | Readonly<{ status: "empty_content" }>;

export async function ingestPdf(workEntryId: string, file: File): Promise<IngestPdfOutcome> {
  const path = apiUrl(`/works/${encodeURIComponent(workEntryId)}/content/pdf`);
  const response = await fetch(path, {
    body: await file.arrayBuffer(),
    headers: { "content-type": pdfContentType },
    method: "POST"
  });

  // The PDF lane is not provisioned on the server (Python/Docling/OCRmyPDF missing): surfaced as 503
  // so it reads as "enable the capability", not "your file is broken" (#510).
  if (response.status === 503) {
    return { status: "pdf_toolchain_missing" };
  }

  if (response.status === 422) {
    const body = (await response.json()) as { error?: string };

    return body.error === "invalid_pdf" ? { status: "invalid_pdf" } : { status: "empty_content" };
  }

  if (!response.ok) {
    throw new Error(`Request to ${path} failed with status ${response.status}.`);
  }

  return { content: (await response.json()) as WorkContentDto, status: "ingested" };
}
