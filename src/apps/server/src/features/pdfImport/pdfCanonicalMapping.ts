import type { BoundingBox, StructuredDocItem, StructuredDocument } from "@whetstone/contracts";
import {
  assignNodeIds,
  parseDocument,
  serializeDocument,
  type DocumentNodeJSON
} from "@whetstone/document";

import type { PersistableReadingUnit } from "../content/blockWriter.js";
import type { IngestedBlock } from "../content/htmlToDocument.js";

// The pure canonicalization core for #702: map ONE validated structured PDF document (#701's projection,
// reconstructed from an attempt's committed ranges) into whetstone's canonical Author->Work->ReadingUnit
// ->Block model, storing content ONLY as ProseMirror/Tiptap `doc_blocks` (never Markdown/mdast). Layout
// order, labels, tables, and figures are fallible EVIDENCE, so the raw docling label decides the node
// type, page geometry/confidence are retained additively as block evidence, and a construct the schema
// cannot represent becomes an explicit `unknown` node (visible, never silently dropped).
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

// A structured PDF with any text-less page (a page #701 found no native text on) cannot be canonicalized
// as-is (#745). Every Work language now ships an OCR pack (#746), so a text-less page reaching this
// mapping means the OCR pass and the full conversion DISAGREED, or OCR was incomplete: the whole
// publication is refused with a typed `ocr_validation_failed` outcome and NO partial Work is created. A
// PDF whose pages carry native text but map to ZERO canonical blocks (an empty body) is refused with a
// typed `no_content` outcome, so publication never creates an empty-shell Work (#702's "no empty shell").
// A PDF that contains picture/figure constructs is refused with a typed `image_unsupported` outcome: #701
// emits no extractable image bytes, so the image cannot be preserved through the image-resource boundary,
// and publishing a null-image placeholder would silently lose content — the whole document fails visibly
// instead (#702's "fail visibly when a construct cannot map"). The affected page/image count is reported.
export type PdfCanonicalMappingResult =
  | Readonly<{ status: "ocr_validation_failed"; pagesNeedingOcr: number }>
  | Readonly<{ status: "no_content" }>
  | Readonly<{ status: "image_unsupported"; unpreservableImages: number }>
  | Readonly<{
      status: "mapped";
      units: readonly PersistableReadingUnit[];
      evidence: readonly PdfBlockEvidence[];
      // The distinct docling labels that had no canonical node type and became `unknown` nodes, so the
      // caller can record the fail-loud gap without re-walking the tree.
      unmappedLabels: readonly string[];
    }>;

// A body item paired with the canonical block node it projected to, carrying the source item so the
// block's evidence (page/geometry/confidence/label) can be keyed once the node has a stable id.
type MappedBlock = Readonly<{ node: DocumentNodeJSON; source: StructuredDocItem; label: string }>;

type DraftUnit = { title: string | null; blocks: MappedBlock[] };

// The heading level each heading label starts at. A `title` is the work-level heading (level 1) and a
// `section_header` is a section (level 2); the projection carries no depth, so the level is assigned
// deterministically from the label rather than guessed from geometry.
const HEADING_LEVEL_BY_LABEL: Readonly<Record<string, number>> = { title: 1, section_header: 2 };
const LIST_GROUP_LABELS = new Set(["list", "ordered_list", "unordered_list"]);
const HEADER_CELL_LABELS = new Set(["table_header", "column_header", "row_header"]);
// Picture/figure constructs whose image bytes #701 does not extract. Their presence refuses the whole
// publication (`image_unsupported`) rather than publishing a content-losing null-image placeholder.
const PICTURE_LABELS = new Set(["picture", "figure"]);

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

// Count the picture/figure constructs anywhere in the body tree (including nested inside lists or table
// cells): each one carries an image #701 cannot extract, so any occurrence refuses the whole document.
function countUnpreservableImages(items: readonly StructuredDocItem[]): number {
  return items.reduce(
    (total, item) =>
      total + (PICTURE_LABELS.has(item.label) ? 1 : 0) + countUnpreservableImages(item.children),
    0
  );
}

// Project one top-level body item to its canonical block node. The raw docling label decides the node
// type; a construct with no canonical representation (or an empty table/list) becomes a visible `unknown`
// node so nothing a publisher wrote is silently dropped. Picture/figure constructs never reach here — a
// document containing one is refused as `image_unsupported` before mapping.
function bodyItemToBlock(item: StructuredDocItem): DocumentNodeJSON {
  const headingLevel = HEADING_LEVEL_BY_LABEL[item.label];
  if (headingLevel !== undefined) {
    return { attrs: { level: headingLevel }, content: inlineContent(item.text), type: "heading" };
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

// Walk the ordered body into (node, source) pairs, grouping a run of top-level `list_item`s into one
// bullet list (docling sometimes emits list items without a wrapping group).
function walkBody(body: readonly StructuredDocItem[]): MappedBlock[] {
  const out: MappedBlock[] = [];
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
    out.push({ label: item.label, node: bodyItemToBlock(item), source: item });
    index += 1;
  }
  return out;
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

  // A picture/figure carries an image #701 does not extract, so it cannot be preserved through the
  // image-resource boundary. Refuse the whole document (no null-image placeholder is ever published)
  // before mapping, reporting how many images were affected (#702's "fail visibly when a construct
  // cannot map").
  const unpreservableImages = countUnpreservableImages(document.body);
  if (unpreservableImages > 0) {
    return { status: "image_unsupported", unpreservableImages };
  }

  const walked = walkBody(document.body);
  const unmapped = new Set<string>();
  for (const block of walked) {
    if (block.node.type === "unknown") {
      unmapped.add(block.label);
    }
  }

  const units: PersistableReadingUnit[] = [];
  const evidence: PdfBlockEvidence[] = [];
  for (const draft of splitIntoUnits(walked)) {
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

  return { evidence, status: "mapped", unmappedLabels: [...unmapped], units };
}
