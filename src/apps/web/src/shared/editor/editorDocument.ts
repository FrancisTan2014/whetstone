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

// Compare two documents by their content, ignoring per-block `id` attrs AND object key order. The editor
// stamps a fresh id onto any block that loads without one (a freshly created work's canonical empty
// paragraph carries `id: null`), and the server reassembles a stored document as `{ content, type }`
// while the editor serializes as `{ type, content }` — so two documents can be the same content while
// differing only in generated ids and key order. `JSON.stringify` is order-sensitive, so both documents
// are first rebuilt into a canonical, id-free shape. Dirty/saved detection must treat those differences
// as "unchanged" so opening a work never reads "Unsaved changes" before an edit and a just-saved
// document is not falsely flagged dirty.
export function editorDocumentsEqualIgnoringIds(
  left: DocumentNodeJSON,
  right: DocumentNodeJSON
): boolean {
  return (
    JSON.stringify(canonicalizeForCompare(left)) === JSON.stringify(canonicalizeForCompare(right))
  );
}

function canonicalizeForCompare(node: DocumentNodeJSON): unknown {
  const canonical: Record<string, unknown> = { type: node.type };

  const attrs = canonicalAttrs(node.attrs);
  if (attrs !== undefined) {
    canonical["attrs"] = attrs;
  }

  if (node.marks !== undefined) {
    canonical["marks"] = node.marks.map((mark) => {
      const canonicalMark: Record<string, unknown> = { type: mark.type };
      const markAttrs = canonicalAttrs(mark.attrs);
      if (markAttrs !== undefined) {
        canonicalMark["attrs"] = markAttrs;
      }
      return canonicalMark;
    });
  }

  if (node.text !== undefined) {
    canonical["text"] = node.text;
  }

  if (node.content !== undefined) {
    canonical["content"] = node.content.map(canonicalizeForCompare);
  }

  return canonical;
}

// Drop the volatile `id` and emit the remaining attrs in a stable key order, so a document that differs
// only in generated ids or attr ordering canonicalizes identically.
function canonicalAttrs(
  attrs: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (attrs === undefined) {
    return undefined;
  }

  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(attrs).sort()) {
    if (key !== "id") {
      canonical[key] = attrs[key];
    }
  }

  return canonical;
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
