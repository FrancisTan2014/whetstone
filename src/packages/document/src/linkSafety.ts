// A pure, dependency-free predicate for the document model's link safety policy, kept in its own
// module so read-only consumers (the reader's PmDocument link renderer) can import it without pulling
// in the heavy Tiptap node/mark extension instances defined in nodes.ts. Importing a runtime value out
// of nodes.ts drags its whole module-scope schema (and @tiptap/extension-unique-id) into the reader
// bundle; this seam keeps that ~40 kB of editor-only weight out of the read path.

// A safe authored href is http(s), mailto, a same-document anchor, or a root-relative path. A
// protocol-relative `//host` is rejected (it escapes the app origin), as is any other scheme
// (javascript:, data:, etc.), so an authored link can never hijack the SPA route or inject script.
const SAFE_DOCUMENT_LINK = /^(?:https?:|mailto:|#|\/(?!\/))/i;

export function isSafeDocumentLinkHref(value: unknown): value is string {
  return typeof value === "string" && SAFE_DOCUMENT_LINK.test(value);
}
