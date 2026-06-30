import { Node } from "@tiptap/core";
import { UniqueID } from "@tiptap/extension-unique-id";

// The whetstone content bedrock: ProseMirror node specs, declared through Tiptap (MIT) so the same
// document model serves ingestion, storage, reader, and the future editor (PRODUCT "Architecture: the
// document-model bedrock"). This module defines the schema shape only — no DOM parsing/serialization
// (that belongs to the ingestion and reader slices, where jsdom enters) and no editing UI. Each node
// carries a stable id (Tiptap UniqueID, below) so notes and cross-references can address it durably.

// --- Structural roots -------------------------------------------------------------------------

const doc = Node.create({ content: "block+", name: "doc", topNode: true });

const text = Node.create({ group: "inline", name: "text" });

// --- Prose blocks -----------------------------------------------------------------------------

const paragraph = Node.create({ content: "inline*", group: "block", name: "paragraph" });

const heading = Node.create({
  addAttributes() {
    return { level: { default: 1 } };
  },
  content: "inline*",
  group: "block",
  name: "heading"
});

const blockquote = Node.create({ content: "block+", group: "block", name: "blockquote" });

// A code block holds plain text only (no inline marks) so source code survives verbatim.
const codeBlock = Node.create({
  addAttributes() {
    return { language: { default: null } };
  },
  code: true,
  content: "text*",
  defining: true,
  group: "block",
  marks: "",
  name: "codeBlock"
});

// --- Lists (with nesting) ---------------------------------------------------------------------

// A list item leads with a paragraph and may nest further blocks (including child lists), so ordered
// and bullet lists nest to arbitrary depth.
const listItem = Node.create({ content: "paragraph block*", defining: true, name: "listItem" });

const bulletList = Node.create({ content: "listItem+", group: "block", name: "bulletList" });

const orderedList = Node.create({
  addAttributes() {
    return { start: { default: 1 } };
  },
  content: "listItem+",
  group: "block",
  name: "orderedList"
});

// --- Tables -----------------------------------------------------------------------------------

const tableCell = Node.create({
  addAttributes() {
    return { colspan: { default: 1 }, rowspan: { default: 1 } };
  },
  content: "block+",
  name: "tableCell"
});

const tableHeader = Node.create({
  addAttributes() {
    return { colspan: { default: 1 }, rowspan: { default: 1 } };
  },
  content: "block+",
  name: "tableHeader"
});

const tableRow = Node.create({ content: "(tableCell | tableHeader)+", name: "tableRow" });

const table = Node.create({ content: "tableRow+", group: "block", name: "table" });

// --- Figures ----------------------------------------------------------------------------------

// A figure pairs a display-only image with an optional caption (PRODUCT reader readability: EPUB
// images become real figures). The image is a leaf with no group, so it is only valid inside a
// figure; a missing image degrades to its caption at render time, never a stray heading.
const image = Node.create({
  addAttributes() {
    // `imageResourceId` references a stored, content-addressed EPUB image (resolved at ingest, #311/#312)
    // so the read-only reader can serve it from the image store; `src` is the transient source href.
    return { alt: { default: null }, imageResourceId: { default: null }, src: { default: null } };
  },
  name: "image"
});

const figureCaption = Node.create({ content: "inline*", name: "figureCaption" });

const figure = Node.create({ content: "image figureCaption?", group: "block", name: "figure" });

// --- Definition lists -------------------------------------------------------------------------

const definitionTerm = Node.create({ content: "inline*", name: "definitionTerm" });

const definitionDescription = Node.create({ content: "block+", name: "definitionDescription" });

const definitionList = Node.create({
  content: "(definitionTerm | definitionDescription)+",
  group: "block",
  name: "definitionList"
});

// --- Callout ----------------------------------------------------------------------------------

// A callout/admonition box: an optional numbered marker plus block content, usable at the top level
// and nested inside lists and blockquotes (it is in the `block` group).
const callout = Node.create({
  addAttributes() {
    return { kind: { default: null }, marker: { default: null } };
  },
  content: "block+",
  group: "block",
  name: "callout"
});

// --- Footnotes / endnotes ---------------------------------------------------------------------

// An inline marker that references a target by its `refId`; the back-link and jump are wired by the
// reader slice from these stable ids (PRODUCT "internal cross-reference links").
const footnoteMarker = Node.create({
  addAttributes() {
    return {
      label: { default: null },
      noteKind: { default: "footnote" },
      refId: { default: null }
    };
  },
  atom: true,
  group: "inline",
  inline: true,
  name: "footnoteMarker"
});

const footnoteTarget = Node.create({
  addAttributes() {
    return {
      label: { default: null },
      noteKind: { default: "footnote" },
      refId: { default: null }
    };
  },
  content: "block+",
  group: "block",
  name: "footnoteTarget"
});

// --- Unknown fallback -------------------------------------------------------------------------

// The conservative fallback for an element the schema does not recognize: its raw HTML is preserved
// verbatim in an attribute so ingestion never silently drops a publisher construct (PRODUCT
// "fail-loud invariant"). It is a leaf so its raw subtree is opaque to the model.
const unknown = Node.create({
  addAttributes() {
    return { html: { default: "" }, tag: { default: null } };
  },
  atom: true,
  group: "block",
  name: "unknown"
});

// The ordered node-spec extensions that define the document schema (everything except the id
// attribute, which UniqueID layers on below).
export const documentNodes = [
  doc,
  text,
  paragraph,
  heading,
  blockquote,
  codeBlock,
  bulletList,
  orderedList,
  listItem,
  table,
  tableRow,
  tableCell,
  tableHeader,
  figure,
  image,
  figureCaption,
  definitionList,
  definitionTerm,
  definitionDescription,
  callout,
  footnoteMarker,
  footnoteTarget,
  unknown
] as const;

// Every node name in the schema, for consumers that need to branch on node type without importing
// the schema object.
export const documentNodeNames = documentNodes.map((node) => node.name) as ReadonlyArray<string>;

// Stable ids on every addressable node. `types: "all"` covers all node types except `doc` and `text`
// (UniqueID's own exclusion), and the default generator/attribute name (`id`, a UUID) is used — this
// is Tiptap's server-side id generator, run with no editor in the document module below.
export const uniqueIdExtension = UniqueID.configure({ types: "all" });

// The full extension set (nodes + the id attribute) passed to `getSchema` and to the server-side id
// generator. Kept as one boundary so the schema and id assignment can never drift apart.
export const documentExtensions = [...documentNodes, uniqueIdExtension];
