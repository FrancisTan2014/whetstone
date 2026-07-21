import { generateUniqueIds } from "@tiptap/extension-unique-id";
import type { JSONContent } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "prosemirror-model";

import { documentExtensions } from "./nodes.js";
import { documentSchema } from "./schema.js";

// The serialized (JSON) form of a ProseMirror node — the shape stored per Block row and exchanged
// over the wire. Kept structural so callers can build documents without importing prosemirror-model.
export interface DocumentNodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNodeJSON[];
  marks?: DocumentMarkJSON[];
  text?: string;
}

export interface DocumentMarkJSON {
  [key: string]: unknown;
  type: string;
  attrs?: Record<string, unknown>;
}

// Raised when a JSON value is not a valid document for the whetstone schema — an unknown node type or
// content that breaks a node's content expression. The underlying ProseMirror error is kept as
// `cause` for diagnostics.
export class DocumentValidationError extends Error {
  constructor(cause: unknown) {
    super("The value is not a valid whetstone document.", { cause });
    this.name = "DocumentValidationError";
  }
}

// Parse and validate a JSON value into a ProseMirror document node rooted at `doc`. `nodeFromJSON`
// rejects unknown node/mark types, `check` enforces every node's content/attribute rules, and the
// root-type guard rejects a valid-but-non-document fragment (e.g. a bare paragraph) — the bedrock
// stores and exchanges document JSON rooted at `doc`, so a block fragment is not a document. Any
// failure surfaces as a `DocumentValidationError` rather than a raw ProseMirror exception.
export function parseDocument(json: unknown): ProseMirrorNode {
  let node: ProseMirrorNode;

  try {
    node = documentSchema.nodeFromJSON(json);
    node.check();
  } catch (cause) {
    throw new DocumentValidationError(cause);
  }

  if (node.type.name !== documentSchema.topNodeType.name) {
    throw new DocumentValidationError(
      new RangeError(
        `Expected a "${documentSchema.topNodeType.name}" root, got "${node.type.name}".`
      )
    );
  }

  return node;
}

// Serialize a document node back to its JSON form for storage or transport.
export function serializeDocument(node: ProseMirrorNode): DocumentNodeJSON {
  return node.toJSON() as DocumentNodeJSON;
}

// Build a valid document from plain text: a single paragraph carrying the text verbatim (a whitespace-
// only or empty string yields an empty paragraph, the same shape an empty editor starts from). The text
// is kept as one text node so `documentText` round-trips it exactly — the diary's durable body is stored
// as this document and its plaintext projection stays byte-identical to the source (tidied/typed) text.
// Validated through `parseDocument`, so the returned JSON is always a well-formed whetstone document.
export function createTextDocument(text: string): DocumentNodeJSON {
  const paragraph: DocumentNodeJSON =
    text.length === 0
      ? { type: "paragraph" }
      : { content: [{ text, type: "text" }], type: "paragraph" };

  return serializeDocument(parseDocument({ content: [paragraph], type: "doc" }));
}

// The plaintext of a document node: the in-order concatenation of its descendant text, with no
// structural whitespace inserted between blocks or inline runs — the same character stream a renderer
// paints. Pure and DOM-free, so the server can derive a stored PM block's searchable/anchorable
// plaintext straight from its node JSON, and a reader can align selection offsets against it.
export function documentText(node: DocumentNodeJSON): string {
  if (node.text !== undefined) {
    return node.text;
  }

  return (node.content ?? []).map(documentText).join("");
}

// A top-level block's heading identity: the level (1-6) it starts at and its trimmed text, or absent
// when the block is not a heading. A manual Work's outline and its Reader hierarchy are BOTH derived
// from this — a stored `heading` `doc_blocks` node is the single source of a section's level and label,
// so no second, editable tree is persisted (issue #697). Pure and DOM-free: the server reads a stored
// block's node JSON, the derivation is unit-testable without the editor or the database. `title` is
// omitted for an empty heading (`#` with no text) so the outline can fall back to its untitled label.
export interface DocumentBlockHeading {
  level: number;
  title?: string;
}

export function documentBlockHeading(node: DocumentNodeJSON): DocumentBlockHeading | undefined {
  if (node.type !== "heading") {
    return undefined;
  }

  // The heading node defaults `level` to 1 and only ever stores 1-6; a missing or non-numeric attr is
  // read as level 1 rather than trusted blindly, so a hand-forged node can never yield a NaN depth that
  // would corrupt the outline's nesting math.
  const rawLevel = (node.attrs as { level?: unknown } | undefined)?.level;
  const level = typeof rawLevel === "number" ? rawLevel : 1;
  const title = documentText(node);

  return title === "" ? { level } : { level, title };
}

// The node types whose content is a single inline run (text + inline nodes): their descendant text is
// one continuous line, so the readable projection joins their children with no separator. Every other
// node is a block CONTAINER whose children are block-level (list items, table rows/cells, nested
// blocks), so those children are joined with a space.
const INLINE_CONTENT_NODE_TYPES = new Set([
  "paragraph",
  "heading",
  "codeBlock",
  "figureCaption",
  "definitionTerm"
]);

// A readable, DOM-free projection of a document node for DISPLAY — e.g. a search snippet. Like
// `documentText`, but it inserts a single space between adjacent block-level children so list items,
// table cells, and stacked blocks read with a boundary instead of running together
// (`valley.Second` becomes `valley. Second`). This is DELIBERATELY separate from `documentText`,
// whose separator-free character stream MUST stay byte-aligned with the reader's `textContent` for
// note-anchor offsets (#344): `documentReadableText` is never used for anchoring, storage, or offset
// math — only for presenting text to a person.
export function documentReadableText(node: DocumentNodeJSON): string {
  if (node.text !== undefined) {
    return node.text;
  }

  const separator = INLINE_CONTENT_NODE_TYPES.has(node.type) ? "" : " ";

  return (node.content ?? [])
    .map(documentReadableText)
    .filter((part) => part.length > 0)
    .join(separator);
}

// Whether a JSON value is a valid document for the schema, without throwing.
export function isValidDocument(json: unknown): boolean {
  try {
    parseDocument(json);
    return true;
  } catch {
    return false;
  }
}

// Stamp a stable id onto every addressable node that lacks one, using Tiptap UniqueID's server-side
// generator (no editor). Idempotent: nodes that already carry an id keep it, so re-running over a
// stored document preserves ids and only fills gaps.
export function assignNodeIds(doc: DocumentNodeJSON): DocumentNodeJSON {
  return generateUniqueIds(doc as unknown as JSONContent, documentExtensions) as DocumentNodeJSON;
}
