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
import {
  MAX_PDF_HEADING_LEVEL,
  decidePageFurniture,
  decidePdfReadingUnits,
  matchOutlineHeading,
  type PageFurnitureExclusionRule,
  type PdfOutlineHeadingMatch
} from "@whetstone/domain";

import type { PersistableReadingUnit } from "../content/blockWriter.js";
import type { IngestedBlock } from "../content/htmlToDocument.js";

// The pure canonicalization core for #702: map ONE validated structured PDF document (#701's projection,
// reconstructed from an attempt's committed ranges) into whetstone's canonical Author->Work->ReadingUnit
// ->Block model, storing content ONLY as ProseMirror/Tiptap `doc_blocks` (never Markdown/mdast). Layout
// order, labels, tables, and figures are fallible EVIDENCE, so the raw docling label decides the node
// type, page geometry/confidence are retained additively as block evidence, and a construct the schema
// cannot represent is degraded rather than dropped: the mapper walks into its children so each descendant
// becomes the block it actually is, and the construct itself becomes an explicit `unknown` node wherever
// it has anything of its own to show (#812). Heading DEPTH is the one thing the label cannot supply, so
// it is resolved from the PDF's own bookmark outline (#815) and falls back to the label table only where
// the document declared nothing.
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

// One top-level body item excluded from the readable hierarchy as page furniture (#811): a running head,
// running foot, or folio docling emitted inside `doc.body`. Nothing a publisher wrote may vanish
// unaccountably, and docling's own `furniture` group is deprecated and empty in 2.114, so the exclusion
// is REPORTED here — page, docling label, the rule that matched, and the normalized text compared — and
// is therefore auditable rather than assumed to be preserved somewhere else.
export type PdfExcludedFurniture = Readonly<{
  page: number;
  label: string;
  rule: PageFurnitureExclusionRule;
  normalizedText: string;
}>;

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
      // The distinct docling labels that had no canonical node type, so the caller can record the
      // fail-loud gap without re-walking the tree. Reported for every unrecognized construct met — one
      // that was expanded into its children, and one that rendered nothing, are reported exactly like one
      // that became a visible `unknown` node (#812).
      unmappedLabels: readonly string[];
      // How many unresolved picture/figure placeholders (#806) were produced. Zero for a document with no
      // pictures; a positive count is a review warning on the successful publication, never a refusal.
      unresolvedFigureCount: number;
      // Where each heading's level came from (#815) — the document's own bookmark outline, or the
      // docling label's last-resort default.
      headingLevelSources: PdfHeadingLevelSources;
      // The page furniture excluded from the readable body (#811), in source order, plus the counts a
      // caller records: how many items were removed and how many characters they carried. Excluded
      // furniture becomes no block and no block evidence — it exists only here.
      excludedFurniture: readonly PdfExcludedFurniture[];
      excludedFurnitureCount: number;
      excludedFurnitureCharacters: number;
    }>;

// A body item paired with the canonical block node it projected to, carrying the source item so the
// block's evidence (page/geometry/confidence/label) can be keyed once the node has a stable id, and the
// heading resolution (#815) so the unit boundary rule (#816) can read the authored navigation without
// re-deciding depth.
type MappedBlock = Readonly<{
  node: DocumentNodeJSON;
  source: StructuredDocItem;
  label: string;
  heading: ResolvedHeading | null;
}>;

type DraftUnit = { title: string | null; blocks: MappedBlock[] };

// Where one heading's level came from: the document's own bookmark outline (real, declared depth) or the
// docling label (a flat default). An outline-derived heading carries the ENTRY that named it — its index
// and title — because a bookmark names ONE heading (#815): the index tells the unit boundary rule (#816)
// that a division is already open (docling splits a chapter opener into `10` + `Classes`, and both halves
// resolve to the same bookmark), and the title is the publisher's own chapter name, which titles the unit
// where the printed heading is a bare label. `null` means the level came from the label table alone, so
// nothing was derived and `headingLevelSources` counts it as assumed.
type ResolvedHeading = Readonly<{
  level: number;
  outlineEntry: Readonly<{ index: number; title: string }> | null;
}>;

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
// How many levels of NESTED unrecognized containers the mapper walks into before it stops expanding
// (#812). Only unrecognized nesting counts — a recognized construct ends the descent — so real documents
// stay far below it (the deepest measured is 2: `document_index` -> `table_row` -> cell). It exists so a
// pathological or hostile nesting cannot hang or stack-overflow the import; at the bound the container
// keeps the pre-#812 behavior of one visible `unknown` node, which is reported and therefore auditable.
const MAX_UNMAPPED_EXPANSION_DEPTH = 16;

// Heading sanity rule (#856): detect when a heading's text is actually a code listing absorbed during
// PDF extraction. A real heading is typically brief (legitimate headings across imported corpus: 27 char
// average, 94-char max in Clean Code, 185-char max in DDIA). A heading > 150 chars that contains
// numbered lines (code pattern: "1 " / "2 " at line starts, with optional leading whitespace) is almost
// certainly a mislabeled code block, not a heading. Split it: treat the first line as caption heading,
// everything after as code block. Fail-safe: if no numbered line pattern is found, keep the original
// heading (no magic-number threshold without structural signal).
//
// Returns { caption?: string, code?: string } when split is justified, else undefined.
function detectAndSplitCodeListing(
  headingText: string
): { caption: string; code: string } | undefined {
  if (headingText.length < 150) {
    return undefined;
  }

  // Look for numbered-line pattern: lines starting with digits followed by space or other code delimiter.
  // Split on the first occurrence of this pattern.
  const lines = headingText.split("\n");
  if (lines.length < 2) {
    // Single-line heading, even if long, without structural indication of code
    return undefined;
  }

  // Find the first line that looks like a numbered code line: "1 " or "2 " or similar, optionally with
  // leading whitespace. Also match lines starting with common code delimiters: /*, //, {, #, etc.
  const codeLine = lines.findIndex((line) => {
    const trimmed = line.trim();
    return (
      /^\d+\s/.test(trimmed) || // line number: "1 ", "42 ", etc.
      /^\/[/*]/.test(trimmed) || // C-style comment: //, /*, etc.
      /^[{#;]/.test(trimmed) || // common code block starts
      /^\*\s/.test(trimmed) // continuation comment line: " * ..."
    );
  });

  if (codeLine <= 0) {
    return undefined;
  }

  // Join lines before the code line as the caption (heading), everything from the code line onward as
  // the code block.
  const caption = lines.slice(0, codeLine).join("\n").trim();
  const code = lines.slice(codeLine).join("\n").trim();

  if (caption.length === 0 || code.length === 0) {
    return undefined;
  }

  return { caption, code };
}

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
//
// This keys on the `_table_rows` SHAPE, never on `label === "table"`, which is why `canonicalBodyNode`
// can route its whole default branch here (#859): docling's table shape is label-agnostic, so a
// `document_index` (a printed table of contents or index) arrives as `table_row`s of cells exactly like
// a `table` does. Any construct that is really a table is therefore mapped as one whatever docling
// called it, and one that is not still returns null and keeps the `unknown` fallback.
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

// Project one body item to its canonical block node, or null when the canonical schema has NO
// representation for it — a construct that is neither a recognized label nor table-shaped, or a
// table/list construct that yielded no row or item. Null is the `unknown`/fallback path, which the
// caller resolves (#812): a container is walked into so its descendants survive, and only a construct
// with something of its own to show becomes an `unknown` node. A picture/figure becomes a canonical
// `figure` placeholder (#806) whose image is unresolved, so the readable document publishes with the
// figure visible for correction rather than the whole document being refused. `heading` is the
// already-resolved depth (#815) — outline-derived where the document declared one — so this projection
// never re-decides it.
function canonicalBodyNode(
  item: StructuredDocItem,
  heading: ResolvedHeading | null
): DocumentNodeJSON | null {
  if (heading !== null) {
    return { attrs: { level: heading.level }, content: inlineContent(item.text), type: "heading" };
  }
  if (PICTURE_LABELS.has(item.label)) {
    return figureNode(item);
  }
  switch (item.label) {
    // A running head/foot that SURVIVED the furniture rules (#811) is unique, folio-less text docling
    // labelled `page_header`/`page_footer` — typically a chapter opener it mislabelled. It is readable
    // content, so it maps to a plain paragraph and never to the dashed `unknown` fallback.
    case "text":
    case "paragraph":
    case "caption":
    case "page_header":
    case "page_footer":
      return paragraph(item.text);
    case "formula":
    case "code":
      return { content: inlineContent(item.text), type: "codeBlock" };
    case "footnote":
    case "endnote":
    case "reference":
      return { content: [paragraph(item.text)], type: "footnoteTarget" };
    case "table":
      return tableNode(item);
    case "list":
    case "ordered_list":
    case "unordered_list":
      return listNode(item);
    // Every remaining label is decided by SHAPE, not by name (#859). `tableNode` reads the item's
    // `_table_rows` children, so a construct docling delivers in table shape under any other label —
    // `document_index` above all, the printed contents/index of a book — becomes the canonical table it
    // actually is. Routing them here is what stops their cell text being lost: an `unknown` node carries
    // its text only in an opaque `html` attr, which `documentText` does not read, so a fragmented index
    // contributed nothing to any block's `plaintext` (measured on Clean Code: 1,243 `unknown` cells, and
    // 70,103 characters absent from the text stream, both recovered by this branch). A construct with no
    // table shape still returns null and takes the unchanged `unknown`/expansion path (#812), so this
    // widens what maps without ever narrowing what survives.
    default:
      return tableNode(item);
  }
}

// Does the mapper have a canonical representation for this item, so that it must be kept whole rather
// than expanded away (#812)? Two shapes map OUTSIDE `canonicalBodyNode` and are named here: a `list_item`,
// which `walkBody` groups with its run into one bullet list, and a heading label, whose depth
// `resolveHeadingLevels` always resolves before the node is built (from the outline, else the label
// default) — so the depth it will be given never decides whether the item maps.
function mapsToCanonicalNode(item: StructuredDocItem): boolean {
  return (
    item.label === "list_item" ||
    HEADING_LEVEL_BY_LABEL[item.label] !== undefined ||
    canonicalBodyNode(item, null) !== null
  );
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
      resolved[index] = {
        level: Math.min(labelLevel, MAX_PDF_HEADING_LEVEL),
        outlineEntry: null
      };
      return;
    }
    claimedEntries.add(match.entryIndex);
    resolved[index] = { level: match.level, outlineEntry: matchedEntry(match, outline) };
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
    resolved[index] = { level: match.level, outlineEntry: matchedEntry(match, outline) };
  });

  return resolved;
}

// The outline entry a match names, reduced to the identity + title the boundary rule reads.
function matchedEntry(
  match: PdfOutlineHeadingMatch,
  outline: readonly PdfOutlineEntry[]
): Readonly<{ index: number; title: string }> {
  return { index: match.entryIndex, title: outline[match.entryIndex]!.title };
}

// Expand every unrecognized CONTAINER in a body run into its children, in source order (#812). Failing to
// recognize a parent must degrade that ONE node, never disinherit everything beneath it: docling groups
// routinely carry all their text in children (a `key_value_area` holds `text` items; a `document_index`
// holds `table_row`s), and the old fallback kept only the parent's own `text` — which for a group is
// empty — so the whole subtree vanished from `plaintext` and `node_json` alike, unreadable, unsearchable
// and uncorrectable. Each lifted descendant is then an ordinary body item: it takes the same rules
// recursively and keys its own page/geometry/confidence evidence, never the ancestor's.
//
// What the unrecognized parent itself becomes:
//   - text of its own  -> a visible `unknown` node BEFORE its children, so evidence of the construct is
//                         never erased;
//   - no text, no children -> NO block. It could only ever render as a blank gap holding a slot in the
//                         reading order, and it is fail-loud through `unmappedLabels` instead;
//   - held at the depth bound -> a visible `unknown` node even when text-less, because there it is the
//                         only remaining trace of a subtree the mapper refuses to walk.
//
// Every unrecognized label is collected whether or not it produced a block, so the fail-loud gap stays
// visible in `unmappedLabels` exactly as before.
function expandUnmappedContainers(
  body: readonly StructuredDocItem[],
  unmappedLabels: Set<string>,
  depth: number
): StructuredDocItem[] {
  const expanded: StructuredDocItem[] = [];
  for (const item of body) {
    if (mapsToCanonicalNode(item)) {
      expanded.push(item);
      continue;
    }
    unmappedLabels.add(item.label);
    const atDepthBound = item.children.length > 0 && depth >= MAX_UNMAPPED_EXPANSION_DEPTH;
    if (item.text.trim().length > 0 || atDepthBound) {
      expanded.push(item);
    }
    if (item.children.length > 0 && !atDepthBound) {
      expanded.push(...expandUnmappedContainers(item.children, unmappedLabels, depth + 1));
    }
  }
  return expanded;
}

// Walk the ordered body into (node, source) pairs, grouping a run of top-level `list_item`s into one
// bullet list (docling sometimes emits list items without a wrapping group). Heading depth is resolved
// once for the whole body against the document's own outline (#815) before the walk, and where each level
// came from is tallied so the caller can report derived-versus-assumed depth. The body it walks is the
// EXPANDED one (#812), so a descendant lifted out of an unrecognized container is an ordinary body item
// here: it takes the same rules, joins a neighbouring `list_item` run, and keys its own evidence.
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
        heading: null,
        label: "list",
        node: { content: run.map((child) => listItemNode(child)), type: "bulletList" },
        source: run[0]!
      });
      continue;
    }
    const heading = headings[index]!;
    if (heading !== null) {
      sources[heading.outlineEntry === null ? "label" : "outline"] += 1;

      // Apply heading sanity rule (#856): if heading text is a code listing, split it into caption + code.
      const split = detectAndSplitCodeListing(item.text);
      if (split !== undefined) {
        // Add the caption as a heading block.
        out.push({
          heading,
          label: item.label,
          node: {
            attrs: { level: heading.level },
            content: inlineContent(split.caption),
            type: "heading"
          },
          source: item
        });
        // Add the code as a code block.
        out.push({
          heading: null,
          label: "code",
          node: { content: inlineContent(split.code), type: "codeBlock" },
          source: item
        });
        index += 1;
        continue;
      }
    }
    // Expansion already decided that an item reaching the fallback path here is one that SHOULD show as
    // an `unknown` node: a leaf carrying its own text, or a container held back at the depth bound.
    out.push({
      heading,
      label: item.label,
      node: canonicalBodyNode(item, heading) ?? unknownNode(item),
      source: item
    });
    index += 1;
  }
  return { blocks: out, headingLevelSources: sources };
}

// Split the walked blocks into reading units at the document's AUTHORED top-level divisions (#816): the
// rule itself is the pure `decidePdfReadingUnits` (domain), which reads each block's heading resolution
// and returns the ascending first-block index and title of every unit. Slicing between consecutive starts
// is what guarantees the property the Reader depends on — every block lands in exactly one unit, in source
// order — and the run before the first division stays one neutral (null-title) "Start" unit.
function splitIntoUnits(blocks: readonly MappedBlock[]): DraftUnit[] {
  const starts = decidePdfReadingUnits(
    blocks.map((block) =>
      block.heading === null
        ? null
        : {
            level: block.heading.level,
            outlineEntry: block.heading.outlineEntry,
            text: block.source.text
          }
    )
  );
  return starts.map((start, index) => ({
    blocks: blocks.slice(start.blockIndex, starts[index + 1]?.blockIndex ?? blocks.length),
    title: start.title
  }));
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

// Split a document's ordered top-level body into the items that are readable content and the page
// furniture excluded from it (#811). The rules are evaluated over the WHOLE document (repetition and
// heading restatement are only visible across pages), and every exclusion is returned so the caller can
// account for what was removed.
function partitionPageFurniture(body: readonly StructuredDocItem[]): {
  readable: StructuredDocItem[];
  excluded: PdfExcludedFurniture[];
  excludedCharacters: number;
} {
  const decisions = decidePageFurniture(body);
  const readable: StructuredDocItem[] = [];
  const excluded: PdfExcludedFurniture[] = [];
  let excludedCharacters = 0;
  body.forEach((item, index) => {
    const decision = decisions[index]!;
    if (decision.kind === "body") {
      readable.push(item);
      return;
    }
    excluded.push({
      label: item.label,
      normalizedText: decision.normalizedText,
      page: item.pageNumber,
      rule: decision.rule
    });
    excludedCharacters += item.text.length;
  });
  return { excluded, excludedCharacters, readable };
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

  // Page furniture is printing, not authorship (#811): running heads, running feet, and folios are
  // removed BEFORE the body is walked, so they never become addressable blocks (and never reach the
  // `unknown` fallback that rendered them as dashed debris). They are returned as evidence instead —
  // docling's own `furniture` group is deprecated and empty, so this result is their only record.
  const furniture = partitionPageFurniture(document.body);

  // A construct the canonical schema cannot name is still a CONTAINER of content (#812), so every
  // unrecognized parent is expanded into its children before the walk: its descendants become ordinary
  // body items instead of vanishing behind a parent whose own text is almost always empty. Expansion
  // runs AFTER furniture partitioning so #811's whole-document rules keep judging exactly the top-level
  // items they judge today. Every unrecognized label met on the way is collected here, whether or not it
  // produced a block, so the fail-loud gap is reported even when the construct itself renders nothing.
  const unmapped = new Set<string>();
  const expandedBody = expandUnmappedContainers(furniture.readable, unmapped, 0);

  // A picture/figure carries an image #701 does not yet extract, but an unresolved leaf must not erase
  // the readable pages (#806). Each maps to a visible `figure` placeholder; the count is reported as a
  // review warning on the successful publication rather than refusing the whole document.

  // The PDF's own bookmark outline is the ONLY depth evidence the document carries (#815). It arrives
  // already validated on the contract (absent for a bookmark-less PDF, or for a payload committed before
  // the worker read outlines), and an absent one simply leaves every heading on the label fallback.
  const walked = walkBody(expandedBody, document.outline ?? []);

  let unresolvedFigureCount = 0;
  for (const block of walked.blocks) {
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

  // The pages had native text but yielded no canonical blocks (an empty body, or a body that was
  // entirely page furniture): refuse rather than publishing an empty-shell Work with no readable units
  // (#702's "no empty shell"). Exclusion is never a refusal REASON — a furniture-only document simply
  // has no readable content, so it takes the same typed `no_content` outcome as an empty one.
  const blockCount = units.reduce((total, unit) => total + unit.docBlocks.length, 0);
  if (blockCount === 0) {
    return { status: "no_content" };
  }

  return {
    evidence,
    headingLevelSources: walked.headingLevelSources,
    excludedFurniture: furniture.excluded,
    excludedFurnitureCharacters: furniture.excludedCharacters,
    excludedFurnitureCount: furniture.excluded.length,
    status: "mapped",
    unmappedLabels: [...unmapped],
    unresolvedFigureCount,
    units
  };
}
