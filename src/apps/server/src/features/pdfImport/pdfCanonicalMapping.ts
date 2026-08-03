import type {
  BoundingBox,
  PdfOutlineEntry,
  StructuredDocItem,
  StructuredDocument
} from "@whetstone/contracts";
import {
  assignNodeIds,
  parseDocument,
  serializeDocument,
  type DocumentNodeJSON
} from "@whetstone/document";
import { MAX_PDF_HEADING_LEVEL, matchOutlineHeading } from "@whetstone/domain";

import type { PersistableReadingUnit } from "../content/blockWriter.js";
import type { IngestedBlock } from "../content/htmlToDocument.js";

// The pure canonicalization core for #702: map ONE validated structured PDF document (#701's projection,
// reconstructed from an attempt's committed ranges) into whetstone's canonical Author->Work->ReadingUnit
// ->Block model, storing content ONLY as ProseMirror/Tiptap `doc_blocks` (never Markdown/mdast). Layout
// order, labels, tables, and figures are fallible EVIDENCE, so the raw docling label decides the node
// type, page geometry/confidence are retained additively as block evidence, and a construct the schema
// cannot represent becomes an explicit `unknown` node (visible, never silently dropped). Heading DEPTH is
// the one thing the label cannot supply, so it is resolved from the PDF's own bookmark outline (#815)
// and falls back to the label table only where the document declared nothing.
//
// It is DOM-free and database-free: it only reads the validated contract shape and builds node JSON with
// the shared document builders, so every mapping rule is unit-testable without Fastify or PostgreSQL. The
// server publication command owns persistence and metadata resolution; this module owns the projection.

// One block's retained page/geometry/confidence provenance, keyed by the stable PM `doc_blocks` id it was
// projected into. Additive evidence (#702): the node JSON stays pure content, the geometry lives here.
export type PdfBlockEvidence = Readonly<{
  blockId: string;
  page: number;
  boundingBox: BoundingBox;
  charStart: number;
  charEnd: number;
  confidence: number;
  label: string;
}>;

// How many of a document's heading levels were DERIVED from the PDF's own bookmark outline versus merely
// assumed from the docling label (#815). Recorded per work so a reviewer, and the usability gate, can see
// whether depth was really derived rather than trusting that it was: an all-`label` document is a flat
// outline by construction, and a regression that stops matching shows up here as a number rather than as
// a book that quietly goes flat again.
export type PdfHeadingLevelSources = Readonly<{ outline: number; label: number }>;

// A structured PDF with any text-less page (a page #701 found no native text on) cannot be canonicalized
// as-is (#745). Every Work language now ships an OCR pack (#746), so a text-less page reaching this
// mapping means the OCR pass and the full conversion DISAGREED, or OCR was incomplete: the whole
// publication is refused with a typed `ocr_validation_failed` outcome and NO partial Work is created. A
// PDF whose pages carry native text but map to ZERO canonical blocks (an empty body) is refused with a
// typed `no_content` outcome, so publication never creates an empty-shell Work (#702's "no empty shell").
// A picture/figure construct whose image bytes #701 cannot yet extract does NOT refuse the document
// (#806): an unresolved leaf must not erase otherwise readable pages. It maps to an explicit, editable
// canonical `figure` placeholder (a null-image `image` child carrying a page-identifying fallback label
// plus any extracted caption), so the whole text hierarchy still publishes and the figure stays visible
// for later correction. The count of such placeholders is returned as `unresolvedFigureCount` so
// publication can record it as a review warning rather than a terminal failure.
export type PdfCanonicalMappingResult =
  | Readonly<{ status: "ocr_validation_failed"; pagesNeedingOcr: number }>
  | Readonly<{ status: "no_content" }>
  | Readonly<{
      status: "mapped";
      units: readonly PersistableReadingUnit[];
      evidence: readonly PdfBlockEvidence[];
      // The distinct docling labels that had no canonical node type and became `unknown` nodes, so the
      // caller can record the fail-loud gap without re-walking the tree.
      unmappedLabels: readonly string[];
      // How many unresolved picture/figure placeholders (#806) were produced. Zero for a document with no
      // pictures; a positive count is a review warning on the successful publication, never a refusal.
      unresolvedFigureCount: number;
      // Where each heading's level came from (#815) — the document's own bookmark outline, or the
      // docling label's last-resort default.
      headingLevelSources: PdfHeadingLevelSources;
    }>;

// A body item paired with the canonical block node it projected to, carrying the source item so the
// block's evidence (page/geometry/confidence/label) can be keyed once the node has a stable id.
type MappedBlock = Readonly<{ node: DocumentNodeJSON; source: StructuredDocItem; label: string }>;

type DraftUnit = { title: string | null; blocks: MappedBlock[] };

// Where one heading's level came from: the document's own bookmark outline (real, declared depth) or the
// docling label (a flat default). Reported so an undeserved level is never claimed silently.
type ResolvedHeading = Readonly<{ level: number; source: keyof PdfHeadingLevelSources }>;

// The heading level each heading label starts at when — and ONLY when — the PDF's outline cannot justify
// a real one. A `title` is the work-level heading (level 1) and a `section_header` is a section (level 2).
// This table is a last-resort fallback, not the source of truth: measured across two real books docling
// emitted `title` zero times, so trusting it alone flattens every heading in a book to H2 (#815).
const HEADING_LEVEL_BY_LABEL: Readonly<Record<string, number>> = { title: 1, section_header: 2 };
// Labels that are NOT heading labels but may still name a heading the outline knows about. Docling
// routinely mislabels a chapter opener `page_header`; when the document's own outline names that exact
// text on that exact page, the item IS the chapter heading and is emitted as one at the matched level.
// A candidate the outline does not name keeps its ordinary mapping — a label alone never promotes.
const OUTLINE_PROMOTABLE_LABELS = new Set(["page_header", "page_footer"]);
const LIST_GROUP_LABELS = new Set(["list", "ordered_list", "unordered_list"]);
const HEADER_CELL_LABELS = new Set(["table_header", "column_header", "row_header"]);
// Picture/figure constructs whose image bytes #701 does not yet extract. Rather than refusing the whole
// publication (#806), each maps to an explicit, editable `figure` placeholder so readable pages still
// publish and the unresolved image stays visible for later correction.
const PICTURE_LABELS = new Set(["picture", "figure"]);
// A child label that carries a picture's caption text. Docling emits a picture's caption as a `caption`
// child rather than the picture item's own text, so a placeholder figure adopts it when present.
const CAPTION_LABEL = "caption";

function inlineContent(text: string): DocumentNodeJSON[] {
  return text.length === 0 ? [] : [{ text, type: "text" }];
}

function paragraph(text: string): DocumentNodeJSON {
  return { content: inlineContent(text), type: "paragraph" };
}

function unknownNode(item: StructuredDocItem): DocumentNodeJSON {
  // Preserve the raw text verbatim in the `unknown` node's `html` attribute and keep the source label in
  // `tag`, so an unrecognized construct renders visibly (never dropped) and stays diagnosable.
  return { attrs: { html: item.text, tag: item.label }, type: "unknown" };
}

// Build a bullet/ordered list from a docling list group's `list_item` children (recursing into nested
// list groups), or null when the group has no list items so the caller can fall back to an `unknown`
// node instead of emitting an empty (schema-invalid) list.
function listNode(item: StructuredDocItem): DocumentNodeJSON | null {
  const items = item.children
    .filter((child) => child.label === "list_item")
    .map((child) => listItemNode(child));
  if (items.length === 0) {
    return null;
  }
  return { content: items, type: item.label === "ordered_list" ? "orderedList" : "bulletList" };
}

function listItemNode(child: StructuredDocItem): DocumentNodeJSON {
  const content: DocumentNodeJSON[] = [paragraph(child.text)];
  for (const grandchild of child.children) {
    if (LIST_GROUP_LABELS.has(grandchild.label)) {
      const nested = listNode(grandchild);
      if (nested !== null) {
        content.push(nested);
      }
    }
  }
  return { content, type: "listItem" };
}

// Build a table from a docling table's `table_row` children (each row's children become cells), or null
// when no row yields a cell so the caller can fall back to an `unknown` node rather than an empty table.
function tableNode(item: StructuredDocItem): DocumentNodeJSON | null {
  const rows: DocumentNodeJSON[] = [];
  for (const rowItem of item.children) {
    if (rowItem.label !== "table_row") {
      continue;
    }
    const cells = rowItem.children.map((cell) => ({
      attrs: { colspan: 1, rowspan: 1 },
      content: [paragraph(cell.text)],
      type: HEADER_CELL_LABELS.has(cell.label) ? "tableHeader" : "tableCell"
    }));
    if (cells.length > 0) {
      rows.push({ content: cells, type: "tableRow" });
    }
  }
  if (rows.length === 0) {
    return null;
  }
  return { content: rows, type: "table" };
}

// The non-decorative alt text for an unresolved figure placeholder (#806): it identifies the source page
// so the figure reads as a real, locatable construct in the Reader and shared editor rather than an empty
// or decorative image. It is never the empty string (which would mark the image decorative/aria-hidden).
function figureFallbackLabel(pageNumber: number): string {
  return `Figure from PDF page ${pageNumber} (image not yet extracted)`;
}

// The non-decorative alt text for a RESOLVED figure whose image bytes were preserved (#807): prefer the
// picture's own caption (the most descriptive text a reader/screen-reader benefits from), else a plain
// page locator. Never empty, so a resolved figure is never treated as decorative/aria-hidden.
function resolvedFigureAlt(item: StructuredDocItem): string {
  const caption = figureCaptionText(item);
  return caption.length > 0 ? caption : `Figure from PDF page ${item.pageNumber}`;
}

// The caption text for an unresolved figure: docling emits a picture's caption as a `caption` child, so
// prefer the first such child's text; fall back to the picture item's own text. Empty when neither
// carries any, so the placeholder figure omits its optional `figureCaption`.
function figureCaptionText(item: StructuredDocItem): string {
  const captionChild = item.children.find((child) => child.label === CAPTION_LABEL);
  const caption = (captionChild?.text ?? item.text).trim();
  return caption;
}

// Map a picture/figure construct to a canonical `figure` block. When the worker rendered the picture and
// the server adopted its artifact (#807), the `image` child carries the content-addressed
// `imageResourceId` (the artifact's sha256, which is the id `ImageResourceStore` stores it under) so the
// Reader serves the real image. When no artifact was adopted, it stays the #806 null-image placeholder
// carrying a page-identifying fallback label. Either way the picture's caption rides along as an optional
// `figureCaption`, and the figure is a normal block whose evidence is keyed like any other.
function figureNode(item: StructuredDocItem): DocumentNodeJSON {
  const artifact = item.imageArtifact;
  const imageAttrs =
    artifact !== undefined
      ? { alt: resolvedFigureAlt(item), imageResourceId: artifact.sha256, src: null }
      : { alt: figureFallbackLabel(item.pageNumber), imageResourceId: null, src: null };
  const content: DocumentNodeJSON[] = [{ attrs: imageAttrs, type: "image" }];
  const caption = figureCaptionText(item);
  if (caption.length > 0) {
    content.push({ content: inlineContent(caption), type: "figureCaption" });
  }
  return { content, type: "figure" };
}

// Project one top-level body item to its canonical block node. The raw docling label decides the node
// type; a construct with no canonical representation (or an empty table/list) becomes a visible `unknown`
// node so nothing a publisher wrote is silently dropped. A picture/figure becomes a canonical `figure`
// placeholder (#806) whose image is unresolved, so the readable document publishes with the figure
// visible for correction rather than the whole document being refused. `heading` is the already-resolved
// depth (#815) — outline-derived where the document declared one — so this projection never re-decides it.
function bodyItemToBlock(
  item: StructuredDocItem,
  heading: ResolvedHeading | null
): DocumentNodeJSON {
  if (heading !== null) {
    return { attrs: { level: heading.level }, content: inlineContent(item.text), type: "heading" };
  }
  if (PICTURE_LABELS.has(item.label)) {
    return figureNode(item);
  }
  switch (item.label) {
    case "text":
    case "paragraph":
    case "caption":
      return paragraph(item.text);
    case "formula":
    case "code":
      return { content: inlineContent(item.text), type: "codeBlock" };
    case "footnote":
    case "endnote":
    case "reference":
      return { content: [paragraph(item.text)], type: "footnoteTarget" };
    case "table":
      return tableNode(item) ?? unknownNode(item);
    case "list":
    case "ordered_list":
    case "unordered_list":
      return listNode(item) ?? unknownNode(item);
    default:
      return unknownNode(item);
  }
}

// Resolve every top-level body item's heading depth in ONE pass over the document, so a bookmark can name
// only one heading. Items docling already labelled headings go first and CLAIM the outline entry that
// names them; only then may a furniture-labelled item (a chapter opener docling mislabelled
// `page_header`) claim an entry no real heading took. That ordering is what keeps a running head — which
// restates its chapter title on every page and therefore matches the same bookmark — from being promoted
// into a duplicate heading beside the real one.
//
// Returns one slot per input item, in the SAME order, so the walk can zip resolutions onto the body it
// already traverses. `null` means "not a heading".
function resolveHeadingLevels(
  body: readonly StructuredDocItem[],
  outline: readonly PdfOutlineEntry[]
): readonly (ResolvedHeading | null)[] {
  const resolved: (ResolvedHeading | null)[] = body.map(() => null);
  const claimedEntries = new Set<number>();

  body.forEach((item, index) => {
    const labelLevel = HEADING_LEVEL_BY_LABEL[item.label];
    if (labelLevel === undefined) {
      return;
    }
    const match = matchOutlineHeading({ pageNumber: item.pageNumber, text: item.text }, outline);
    if (match === null) {
      resolved[index] = { level: Math.min(labelLevel, MAX_PDF_HEADING_LEVEL), source: "label" };
      return;
    }
    claimedEntries.add(match.entryIndex);
    resolved[index] = { level: match.level, source: "outline" };
  });

  body.forEach((item, index) => {
    if (!OUTLINE_PROMOTABLE_LABELS.has(item.label)) {
      return;
    }
    const match = matchOutlineHeading({ pageNumber: item.pageNumber, text: item.text }, outline);
    if (match === null || claimedEntries.has(match.entryIndex)) {
      return;
    }
    claimedEntries.add(match.entryIndex);
    resolved[index] = { level: match.level, source: "outline" };
  });

  return resolved;
}

// Walk the ordered body into (node, source) pairs, grouping a run of top-level `list_item`s into one
// bullet list (docling sometimes emits list items without a wrapping group). Heading depth is resolved
// once for the whole body against the document's own outline (#815) before the walk, and where each level
// came from is tallied so the caller can report derived-versus-assumed depth.
function walkBody(
  body: readonly StructuredDocItem[],
  outline: readonly PdfOutlineEntry[]
): { blocks: MappedBlock[]; headingLevelSources: PdfHeadingLevelSources } {
  const headings = resolveHeadingLevels(body, outline);
  const out: MappedBlock[] = [];
  const sources = { label: 0, outline: 0 };
  let index = 0;
  while (index < body.length) {
    const item = body[index]!;
    if (item.label === "list_item") {
      const run: StructuredDocItem[] = [];
      while (index < body.length && body[index]!.label === "list_item") {
        run.push(body[index]!);
        index += 1;
      }
      out.push({
        label: "list",
        node: { content: run.map((child) => listItemNode(child)), type: "bulletList" },
        source: run[0]!
      });
      continue;
    }
    const heading = headings[index]!;
    if (heading !== null) {
      sources[heading.source] += 1;
    }
    out.push({ label: item.label, node: bodyItemToBlock(item, heading), source: item });
    index += 1;
  }
  return { blocks: out, headingLevelSources: sources };
}

// Split the walked blocks into reading units: each heading starts a new unit (so the unit's first block
// is its heading and the Reader derives the outline from it), and any leading run before the first
// heading becomes one neutral (null-title) "Start" unit.
function splitIntoUnits(blocks: readonly MappedBlock[]): DraftUnit[] {
  const units: DraftUnit[] = [];
  let current: DraftUnit | null = null;
  for (const block of blocks) {
    if (block.node.type === "heading") {
      const title = block.source.text.trim();
      current = { blocks: [block], title: title.length > 0 ? title : null };
      units.push(current);
      continue;
    }
    if (current === null) {
      current = { blocks: [], title: null };
      units.push(current);
    }
    current.blocks.push(block);
  }
  return units;
}

// Assign stable node ids to a unit's blocks and decompose them into persistable `doc_blocks`, collecting
// each top-level block's evidence keyed by its assigned id. The unit doc is validated and normalized
// through `parseDocument` first, so an invalid node shape fails loudly here rather than at persistence.
function buildUnit(unit: DraftUnit): {
  persistable: PersistableReadingUnit;
  evidence: PdfBlockEvidence[];
} {
  const normalized = serializeDocument(
    parseDocument({ content: unit.blocks.map((block) => block.node), type: "doc" })
  );
  const withIds = assignNodeIds(normalized);
  // `parseDocument` guarantees a `doc` with `block+` content, so `content` is always present here; the
  // empty fallback is unreachable defensive code that keeps the type non-optional.
  /* v8 ignore next */
  const topLevel = (withIds.content ?? []) as DocumentNodeJSON[];
  const docBlocks: IngestedBlock[] = [];
  const evidence: PdfBlockEvidence[] = [];
  topLevel.forEach((node, order) => {
    const id = String((node.attrs as { id?: unknown } | undefined)?.id);
    const block = unit.blocks[order]!;
    docBlocks.push({ anchorId: null, anchors: [], id, node, type: node.type });
    evidence.push({
      blockId: id,
      boundingBox: block.source.boundingBox,
      charEnd: block.source.charSpan[1],
      charStart: block.source.charSpan[0],
      confidence: block.source.confidence,
      label: block.label,
      page: block.source.pageNumber
    });
  });
  return {
    evidence,
    persistable: {
      blocks: [],
      docBlocks,
      evidence: [],
      sourceFile: null,
      title: unit.title ?? undefined
    }
  };
}

// Map a reconstructed structured PDF document to canonical reading units + block evidence, or refuse the
// whole document when any page is still text-less. Every Work language now ships an OCR pack (#746), so a
// text-less page reaching here means the OCR pass and the full conversion disagreed (or OCR was
// incomplete): the document is refused with `ocr_validation_failed`. Pure: the caller (publication
// command) resolves metadata and persists the result atomically.
export function mapStructuredDocument(document: StructuredDocument): PdfCanonicalMappingResult {
  const pagesNeedingOcr = document.pages.filter((page) => !page.hasNativeText).length;
  if (pagesNeedingOcr > 0) {
    return { pagesNeedingOcr, status: "ocr_validation_failed" };
  }

  // A picture/figure carries an image #701 does not yet extract, but an unresolved leaf must not erase
  // the readable pages (#806). Each maps to a visible `figure` placeholder; the count is reported as a
  // review warning on the successful publication rather than refusing the whole document.

  // The PDF's own bookmark outline is the ONLY depth evidence the document carries (#815). It arrives
  // already validated on the contract (absent for a bookmark-less PDF, or for a payload committed before
  // the worker read outlines), and an absent one simply leaves every heading on the label fallback.
  const walked = walkBody(document.body, document.outline ?? []);
  const unmapped = new Set<string>();
  let unresolvedFigureCount = 0;
  for (const block of walked.blocks) {
    if (block.node.type === "unknown") {
      unmapped.add(block.label);
    }
    // Only a figure whose image was NOT preserved (#806 placeholder) is an unresolved-figure review
    // warning. A figure whose artifact was adopted (#807) carries a resolved `imageResourceId`, so it is
    // a fully readable image and must not inflate the warning count.
    if (block.node.type === "figure" && block.source.imageArtifact === undefined) {
      unresolvedFigureCount += 1;
    }
  }

  const units: PersistableReadingUnit[] = [];
  const evidence: PdfBlockEvidence[] = [];
  for (const draft of splitIntoUnits(walked.blocks)) {
    const built = buildUnit(draft);
    units.push(built.persistable);
    evidence.push(...built.evidence);
  }

  // The pages had native text but yielded no canonical blocks (an empty body): refuse rather than
  // publishing an empty-shell Work with no readable units (#702's "no empty shell"). Every walked item
  // produces at least one block, so zero blocks means the body was empty.
  const blockCount = units.reduce((total, unit) => total + unit.docBlocks.length, 0);
  if (blockCount === 0) {
    return { status: "no_content" };
  }

  return {
    evidence,
    headingLevelSources: walked.headingLevelSources,
    status: "mapped",
    unmappedLabels: [...unmapped],
    unresolvedFigureCount,
    units
  };
}
