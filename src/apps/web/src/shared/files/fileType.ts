import { epubContentType, pdfContentType } from "@whetstone/contracts";

// The three document types the single "Upload" front door accepts. `undefined` means the picked file
// is none of them.
export type UploadKind = "epub" | "pdf" | "markdown";

const markdownContentType = "text/markdown";

// Recognized MIME types are authoritative and consulted FIRST: when the browser reports a known type
// it decides the kind, so a mislabelled extension (e.g. an actual PDF named `.epub`) still routes by
// its real content type.
const mimeKinds: ReadonlyMap<string, UploadKind> = new Map([
  [epubContentType, "epub"],
  [pdfContentType, "pdf"],
  [markdownContentType, "markdown"]
]);

// The filename extension is only a FALLBACK, used when the browser omits the type or reports one we do
// not recognize (common for `.md`, which many browsers leave blank).
const extensionKinds: ReadonlyArray<readonly [string, UploadKind]> = [
  [".epub", "epub"],
  [".pdf", "pdf"],
  [".md", "markdown"]
];

// Classify a picked upload by MIME type first, falling back to the filename extension. Shared by the
// shelf's single "Upload" control and the Manage-content upload form so both route a file the same
// way, with no duplicated logic.
export function detectUploadKind(file: File): UploadKind | undefined {
  const byMime = mimeKinds.get(file.type);
  if (byMime !== undefined) {
    return byMime;
  }

  const name = file.name.toLowerCase();
  const byExtension = extensionKinds.find(([extension]) => name.endsWith(extension));
  return byExtension?.[1];
}

// The filename with its final extension removed — the default title for a PDF/Markdown upload, which
// (unlike an EPUB, whose OPF metadata is authoritative) carries no reliable title of its own.
export function stripFileExtension(fileName: string): string {
  return fileName.replace(/^(.+)\.[^./\\]+$/, "$1");
}
