import { Extension, Mark, Node } from "@tiptap/core";
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
// reader slice from these stable ids (PRODUCT "internal cross-reference links"). `refFile` is the
// source-file path part of a cross-file reference (e.g. `../notes.xhtml#fn12` -> `../notes.xhtml`),
// null for a same-file marker; `targetSourceFile` is that path resolved against the marker's own
// source file at ingest, so the reader's work-scoped resolver can jump to an endnote in another unit
// keyed by (sourceFile, anchor) (#366). Both are addressing metadata intrinsic to the marker, kept in
// the node so the resolver has the full target without re-deriving it.
const footnoteMarker = Node.create({
  addAttributes() {
    return {
      label: { default: null },
      noteKind: { default: "footnote" },
      refFile: { default: null },
      refId: { default: null },
      targetSourceFile: { default: null }
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

// --- Inline marks -----------------------------------------------------------------------------

// The document model's first content MARK: a same-work reference link kept inline on the text run
// (PRODUCT "internal cross-reference links", #368). A mark — not an inline atom — because an atom
// would pull the link text out of the paragraph's inline run and reopen the #340/#358 CJK
// inter-character spacing gaps (`见周髀之术` shattering into `见之术`); a mark keeps the linked text in
// flow while carrying the addressing metadata. `kind` distinguishes an explicit cross-reference
// (`a[data-type=xref]`) from a generic same-work `<a>`; `anchor` is the target's source-HTML id (the
// href `#fragment`); `refFile` is the file part of a cross-file href (`ch01.html#id` -> `ch01.html`,
// null for a same-file `#id`); `targetSourceFile` is that path resolved against the mark's own source
// file at ingest (#366), so the reader's work-scoped resolver can jump keyed by (sourceFile, anchor).
// `inert` marks an external/cross-work link (`http(s):`, `mailto:`, protocol-relative `//`) that
// renders as styled but non-navigating text, never a live `<a href>` that could hijack the SPA route.
const link = Mark.create({
  addAttributes() {
    return {
      anchor: { default: null },
      inert: { default: false },
      kind: { default: "href" },
      refFile: { default: null },
      targetSourceFile: { default: null }
    };
  },
  name: "link"
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

// The mark-spec extensions that define the document schema's content marks. The `link` mark is the
// only one (#368); em/strong/other inline formatting stay descended-to-plain-text for now.
export const documentMarks = [link] as const;

// Every mark name in the schema, mirroring `documentNodeNames` for consumers that branch on mark type.
export const documentMarkNames = documentMarks.map((mark) => mark.name) as ReadonlyArray<string>;

// The block-group node types every top-level block can be. Each carries the addressing-only
// `anchorId` global attribute below, so a block's source-HTML id is captured at ingest without
// polluting non-block nodes (list items, cells, inline runs).
const BLOCK_GROUP_NODE_NAMES = [
  "paragraph",
  "heading",
  "blockquote",
  "codeBlock",
  "bulletList",
  "orderedList",
  "table",
  "figure",
  "definitionList",
  "callout",
  "footnoteTarget",
  "unknown"
] as const;

// `anchorId` is the host element's id at ingest (a figure/heading/paragraph id, a cross-reference
// target), declared on every block-group node so the ingestion parse can carry it robustly through
// wrapper unwrapping — positional correlation is unsafe because publishers wrap chapters (e.g.
// O'Reilly's `<section>`). It is addressing metadata, not render content (exactly like the legacy
// `blocks.anchor_id` column), so ingestion LIFTS it off the top-level node into the `doc_blocks`
// `anchor_id` column and STRIPS it from the stored node JSON — the PM document stays a pure content
// model and the node JSON is byte-identical to before this attribute existed (#366).
const anchorIdAttribute = Extension.create({
  addGlobalAttributes() {
    return [{ attributes: { anchorId: { default: null } }, types: [...BLOCK_GROUP_NODE_NAMES] }];
  },
  name: "anchorIdAttribute"
});

// Stable ids on every addressable node. `types: "all"` covers all node types except `doc` and `text`
// (UniqueID's own exclusion), and the default generator/attribute name (`id`, a UUID) is used — this
// is Tiptap's server-side id generator, run with no editor in the document module below.
export const uniqueIdExtension = UniqueID.configure({ types: "all" });

// The full extension set (nodes + marks + the id attribute + the anchor-id addressing attribute)
// passed to `getSchema` and to the server-side id generator. Kept as one boundary so the schema and
// id assignment can never drift apart.
export const documentExtensions = [
  ...documentNodes,
  ...documentMarks,
  uniqueIdExtension,
  anchorIdAttribute
];
