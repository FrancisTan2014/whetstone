import {
  assignNodeIds,
  type DocumentNodeJSON,
  isSafeDocumentLinkHref,
  parseDocument,
  serializeDocument
} from "@whetstone/document";

export function createEmptyDocument(): DocumentNodeJSON {
  return validateEditorDocument({ content: [{ type: "paragraph" }], type: "doc" });
}

export function validateEditorDocument(value: unknown): DocumentNodeJSON {
  return assignNodeIds(serializeDocument(parseDocument(value)));
}

export function editorDocumentsEqual(left: DocumentNodeJSON, right: DocumentNodeJSON): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function normalizeEditorLinkHref(value: string): string | undefined {
  const trimmed = value.trim();

  if (trimmed === "") {
    return undefined;
  }

  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(trimmed);
  const candidate =
    hasScheme || trimmed.startsWith("#") || trimmed.startsWith("/")
      ? trimmed
      : `https://${trimmed}`;

  return isSafeDocumentLinkHref(candidate) ? candidate : undefined;
}
