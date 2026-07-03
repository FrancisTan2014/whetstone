import { epubContentType, pdfContentType } from "@whetstone/contracts";

// Detect a picked upload's type by MIME type first, falling back to the filename extension when the
// browser omits the type. Shared by the shelf's single "Upload" control and the Manage-content upload
// form so both features route a file the same way, with no duplicated logic.

export function isEpubFile(file: File): boolean {
  return file.type === epubContentType || file.name.toLowerCase().endsWith(".epub");
}

export function isPdfFile(file: File): boolean {
  return file.type === pdfContentType || file.name.toLowerCase().endsWith(".pdf");
}

export function isMarkdownFile(file: File): boolean {
  return file.type === "text/markdown" || file.name.toLowerCase().endsWith(".md");
}

// The filename with its final extension removed — the default title for a PDF/Markdown upload, which
// (unlike an EPUB, whose OPF metadata is authoritative) carries no reliable title of its own.
export function stripFileExtension(fileName: string): string {
  return fileName.replace(/^(.+)\.[^./\\]+$/, "$1");
}
