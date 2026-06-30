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
  marks?: Array<Record<string, unknown>>;
  text?: string;
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
