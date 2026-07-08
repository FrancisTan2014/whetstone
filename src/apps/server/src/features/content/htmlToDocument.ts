import { JSDOM } from "jsdom";
import { DOMParser, type ParseRule } from "prosemirror-model";

import {
  assignNodeIds,
  documentSchema,
  type DocumentNodeJSON,
  serializeDocument
} from "@whetstone/document";

// Server-side fidelity ingestion: turn one source HTML fragment (an EPUB chapter's XHTML) into a
// ProseMirror/Tiptap document for the whetstone content bedrock (#310), then decompose it into block
// rows. The invariant is FAIL-LOUD: nothing a publisher wrote is silently dropped. Every block-level
// element the schema does not recognize becomes a conservative `unknown` node (its raw HTML preserved
// verbatim) AND emits a structured evidence record so the gap is visible, not invisible.
//
// Why the DOM work lives here and not in `@whetstone/document`: parse rules are DOM-typed
// (`getAttrs` reads `HTMLElement` attributes) and depend on jsdom, so they belong to the ingestion
// layer. The pure package stays `lib: ES2022` with no DOM and no `parseDOM` specs — its schema and
// JSON round-trip never touch a browser. We therefore build the `DOMParser` from an EXPLICIT rules
// array bound to `documentSchema`'s node types rather than `DOMParser.fromSchema` (which would need
// `parseDOM` specs the pure package intentionally does not carry).

// A record of one block-level element the schema did not recognize, captured so a publisher construct
// is never dropped without a trace.
export interface IngestionEvidence {
  tag: string;
  attributes: Record<string, string>;
  path: string;
  adjacentText: string;
}

// One top-level block of the ingested document: its stable id, node type, the ProseMirror node
// JSON to persist as a Block row, and the source-HTML `anchorId` lifted off the node (a cross-reference
// target such as a figure/heading id; null when the source element had no id). `anchorId` rides
// alongside the node — not inside its JSON — because it is addressing metadata, not render content
// (#366), mirroring the legacy `blocks.anchor_id` column.
export interface IngestedBlock {
  id: string;
  type: string;
  node: DocumentNodeJSON;
  anchorId: string | null;
}

// The full result of ingesting one HTML fragment: the whole document, its decomposition into block
// rows, and the fail-loud evidence log of unrecognized elements.
export interface HtmlIngestionResult {
  doc: DocumentNodeJSON;
  blocks: IngestedBlock[];
  evidence: IngestionEvidence[];
}

// Callout/admonition kinds the schema recognizes (O'Reilly-style `<div data-type="note">` boxes).
const CALLOUT_KINDS = ["note", "warning", "tip", "caution", "important"] as const;

// `data-type` values that mark an element as recognized regardless of its tag: the callout kinds plus
// the footnote marker (`a[data-type=noteref]`) and footnote target (`*[data-type=footnote]`).
const RECOGNIZED_DATA_TYPES = new Set<string>([...CALLOUT_KINDS, "noteref", "footnote"]);

// Block-level tags that have a parse rule below. An element with one of these tags is recognized and
// never flagged.
const RECOGNIZED_TAGS = new Set<string>([
  "blockquote",
  "dd",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "table",
  "td",
  "th",
  "tr",
  "ul"
]);

// Inline/formatting and generic-container tags we descend through and keep the text of, but never
// flag. Inline marks (em/strong/code/...) are intentionally not in the #310 schema yet (a later
// slice), so tolerated inline formatting is descended and its text preserved as plain text. This
// includes the legacy monospace/formatting family (`tt`, `big`, `font`, `strike`, `acronym`) that
// Calibre-converted EPUBs emit constantly and the CJK ruby group (`ruby`/`rt`/`rp`) — an inline
// element NOT listed here would otherwise be treated as an unknown block and shatter its paragraph
// (#357). `hr` is a decorative, textless block-level thematic break we tolerate as a silent drop (no
// content to keep, and not a dropped publisher construct, so it emits no fail-loud evidence).
const TOLERATED_TAGS = new Set<string>([
  "a",
  "abbr",
  "acronym",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "big",
  "br",
  "cite",
  "code",
  "col",
  "colgroup",
  "del",
  "dfn",
  "div",
  "em",
  "font",
  "footer",
  "header",
  "hr",
  "i",
  "ins",
  "kbd",
  "main",
  "mark",
  "nav",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "tbody",
  "tfoot",
  "thead",
  "time",
  "tt",
  "u",
  "var",
  "wbr"
]);

const ADJACENT_TEXT_LIMIT = 80;

// MathML is handled as a tolerated atom (its `textContent` is kept; its subtree is not descended).
const MATH_TAG = "math";

type ElementKind = "recognized" | "tolerated" | "unknown";

// Read a code block's language from `data-code-language`, then from a `language-<x>` class token
// (the de-facto highlight.js convention), falling back to `null` when neither is present.
function readCodeLanguage(element: HTMLElement): string | null {
  const explicit = element.getAttribute("data-code-language");

  if (explicit !== null) {
    return explicit;
  }

  const className = element.getAttribute("class");

  if (className === null) {
    return null;
  }

  const prefix = "language-";
  const token = className.split(/\s+/).find((part) => part.startsWith(prefix));

  if (token === undefined) {
    return null;
  }

  return token.slice(prefix.length);
}

// Read an ordered list's `start`, defaulting to 1 when absent.
function readOrderedListAttrs(element: HTMLElement): { start: number } {
  const start = element.getAttribute("start");

  return { start: start === null ? 1 : Number.parseInt(start, 10) };
}

// Read a table cell/header span attribute, defaulting to 1 when absent.
function readSpan(element: HTMLElement, name: string): number {
  const value = element.getAttribute(name);

  return value === null ? 1 : Number.parseInt(value, 10);
}

function readCellAttrs(element: HTMLElement): { colspan: number; rowspan: number } {
  return { colspan: readSpan(element, "colspan"), rowspan: readSpan(element, "rowspan") };
}

function readImageAttrs(element: HTMLElement): { alt: string | null; src: string | null } {
  return { alt: element.getAttribute("alt"), src: element.getAttribute("src") };
}

// A callout carries its kind (the `data-type` value); the optional numbered marker is wired by a
// later slice, so it is null at ingestion.
function readCalloutAttrs(element: HTMLElement): { kind: string | null; marker: null } {
  return { kind: element.getAttribute("data-type"), marker: null };
}

// Element.textContent is typed `string | null`, but is always a string for an element; `String()`
// normalizes it without an unreachable null-branch so branch coverage stays exact.
function elementText(element: HTMLElement): string {
  return String(element.textContent).trim();
}

// @lingo-reader rewrites every intra-EPUB reference href to a virtual `epub:` scheme carrying the
// manifest-root path (`epub:OEBPS/ch10.html`), which the reading unit's `source_file` and the work
// anchor index do NOT carry (#501/#507). Rewrite it to a root-absolute path so the reference resolves
// to the scheme-less (source_file, anchor) the index is keyed on: left as-is, `isExternalHref` treats
// the `epub:` scheme as an external URL (rendering an inert xref) and `resolveRelativeHref` mangles the
// stamped `targetSourceFile` into `OEBPS/epub:OEBPS/...`. A non-`epub:` href is returned unchanged.
function normalizeReferenceHref(href: string): string {
  return href.replace(/^epub:\/?/iu, "/");
}

// A footnote marker references its target by `refId` and, for a cross-file endnote, the file part
// `refFile`: a `href="path#id"` splits into (`path` -> refFile, `id` -> refId), a same-document
// `href="#id"` yields (null, id), and an explicit `data-target` yields (null, target). An empty path
// or id normalizes to null. Capturing the path (which `readRefId` used to drop) lets the reader's
// work-scoped resolver reach an endnote living in a separate source file (#366).
function readFootnoteRef(element: HTMLElement): {
  refFile: string | null;
  refId: string | null;
} {
  const rawHref = element.getAttribute("href");
  const href = rawHref === null ? null : normalizeReferenceHref(rawHref);

  if (href !== null && href.includes("#")) {
    const hashIndex = href.indexOf("#");
    const path = href.slice(0, hashIndex);
    const id = href.slice(hashIndex + 1);

    return { refFile: path === "" ? null : path, refId: id === "" ? null : id };
  }

  return { refFile: null, refId: element.getAttribute("data-target") };
}

function readFootnoteMarkerAttrs(element: HTMLElement): {
  label: string;
  noteKind: string;
  refFile: string | null;
  refId: string | null;
} {
  const { refFile, refId } = readFootnoteRef(element);

  return { label: elementText(element), noteKind: "footnote", refFile, refId };
}

function readFootnoteTargetAttrs(element: HTMLElement): { refId: string | null } {
  return { refId: element.getAttribute("id") };
}

// Whether an href points OUTSIDE the work, so the link stays inert (no navigation): a URL scheme
// (`http:`, `https:`, `mailto:`, `tel:`, …) or a protocol-relative `//host` reference. A relative
// path and/or a bare `#fragment` is a same-work reference and is preserved as a live jump instead.
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");
}

// Split a same-work href into its file part (`refFile`, null for a same-file `#id`) and anchor (the
// `#fragment` id, null when the href carries no fragment). Mirrors the footnote split so a link and a
// noteref reach the reader's work-scoped resolver keyed the same way (#366): `ch01.html#intro` ->
// (`ch01.html`, `intro`), `#intro` -> (null, `intro`), `ch02.html` -> (`ch02.html`, null).
function splitHref(href: string): { anchor: string | null; refFile: string | null } {
  const hashIndex = href.indexOf("#");

  if (hashIndex === -1) {
    return { anchor: null, refFile: href };
  }

  const path = href.slice(0, hashIndex);
  const id = href.slice(hashIndex + 1);

  return { anchor: id === "" ? null : id, refFile: path === "" ? null : path };
}

// The `link` mark's attributes for an `<a>`, or `false` to skip the rule (leaving the anchor's text
// in flow) when it carries no usable href — a bare `<a name=…>`/`<a>` is not a reference. `kind`
// records an explicit cross-reference (`data-type=xref`) versus a generic same-work link. An external
// or cross-work href (a URL scheme / protocol-relative) is preserved as INERT with no target, so it
// renders as styled-but-dead text; a same-work href keeps its `anchor` + `refFile` for the ingest
// `targetSourceFile` stamp (#366). `a[data-type=noteref]` never reaches this rule — the footnoteMarker
// node rule precedes it and wins.
function readLinkAttrs(element: HTMLElement): false | Record<string, unknown> {
  const rawHref = element.getAttribute("href");

  if (rawHref === null || rawHref === "") {
    return false;
  }

  const href = normalizeReferenceHref(rawHref);
  const kind = element.getAttribute("data-type") === "xref" ? "xref" : "href";

  if (isExternalHref(href)) {
    return { anchor: null, inert: true, kind, refFile: null, targetSourceFile: null };
  }

  const { anchor, refFile } = splitHref(href);

  return { anchor, inert: false, kind, refFile, targetSourceFile: null };
}

// The unknown fallback reads back the raw HTML and original tag the pre-walk stamped onto the
// sentinel, so the publisher construct is preserved verbatim in the model.
function readUnknownAttrs(element: HTMLElement): { html: string | null; tag: string | null } {
  return { html: element.getAttribute("data-raw"), tag: element.getAttribute("data-tag") };
}

// Compose an existing block-rule `getAttrs` (if any) with the source element's `id`, captured as the
// block-group `anchorId` attribute so a block's in-work cross-reference target survives ingestion
// robustly through wrapper unwrapping (#366). Ingestion lifts it off the top-level node and strips it
// from the stored JSON, so this only rides the parse; non-block rules (list items, cells, images,
// markers) deliberately omit it — their owning top-level block holds the address.
function withAnchorId(
  getAttrs?: (element: HTMLElement) => Record<string, unknown>
): (element: HTMLElement) => Record<string, unknown> {
  return (element) => ({ ...(getAttrs?.(element) ?? {}), anchorId: element.getAttribute("id") });
}

// One parse rule per heading level so the level is a static attr rather than a parsed one.
const headingRules: ParseRule[] = [1, 2, 3, 4, 5, 6].map((level) => ({
  getAttrs: withAnchorId(() => ({ level })),
  node: "heading",
  tag: `h${level}`
}));

// One parse rule per callout kind, each stamping the kind from its `data-type`.
const calloutRules: ParseRule[] = CALLOUT_KINDS.map((kind) => ({
  getAttrs: withAnchorId(readCalloutAttrs),
  node: "callout",
  tag: `div[data-type=${kind}]`
}));

// The explicit rules array bound to `documentSchema`'s node types (see file header for why this is
// not `DOMParser.fromSchema`). Order matters only where selectors overlap; here they are disjoint.
// Every block-group rule captures the element `id` via `withAnchorId` (#366); non-block rules do not.
const RULES: ParseRule[] = [
  ...headingRules,
  { getAttrs: withAnchorId(), node: "paragraph", tag: "p" },
  { getAttrs: withAnchorId(), node: "blockquote", tag: "blockquote" },
  {
    getAttrs: withAnchorId((element) => ({ language: readCodeLanguage(element) })),
    node: "codeBlock",
    preserveWhitespace: "full",
    tag: "pre"
  },
  { getAttrs: withAnchorId(), node: "bulletList", tag: "ul" },
  { getAttrs: withAnchorId(readOrderedListAttrs), node: "orderedList", tag: "ol" },
  { node: "listItem", tag: "li" },
  { getAttrs: withAnchorId(), node: "table", tag: "table" },
  { node: "tableRow", tag: "tr" },
  { getAttrs: readCellAttrs, node: "tableCell", tag: "td" },
  { getAttrs: readCellAttrs, node: "tableHeader", tag: "th" },
  { getAttrs: withAnchorId(), node: "figure", tag: "figure" },
  { getAttrs: readImageAttrs, node: "image", tag: "img" },
  { node: "figureCaption", tag: "figcaption" },
  { getAttrs: withAnchorId(), node: "definitionList", tag: "dl" },
  { node: "definitionTerm", tag: "dt" },
  { node: "definitionDescription", tag: "dd" },
  ...calloutRules,
  { getAttrs: readFootnoteMarkerAttrs, node: "footnoteMarker", tag: "a[data-type=noteref]" },
  // The same-work reference link mark (#368). Placed AFTER the noteref node rule so a footnote marker
  // still parses to the `footnoteMarker` atom (rule order decides when selectors overlap); every other
  // `<a>` becomes an inline `link` mark on its text (a bare hrefless anchor skips the rule and stays
  // plain text). `codeBlock` allows no marks, so an `<a>` inside `<pre>` keeps its text without a mark.
  { getAttrs: readLinkAttrs, mark: "link", tag: "a" },
  {
    getAttrs: withAnchorId(readFootnoteTargetAttrs),
    node: "footnoteTarget",
    tag: "[data-type=footnote]"
  },
  { getAttrs: withAnchorId(readUnknownAttrs), node: "unknown", tag: "div[data-whetstone-unknown]" }
];

// Classify an element for the fail-loud pre-walk: recognized (has a parse rule), tolerated (descend
// and keep text), or unknown (flag and replace with a sentinel).
function classify(element: Element): ElementKind {
  const tag = element.tagName.toLowerCase();
  const dataType = element.getAttribute("data-type");

  if (dataType !== null && RECOGNIZED_DATA_TYPES.has(dataType)) {
    return "recognized";
  }

  if (RECOGNIZED_TAGS.has(tag)) {
    return "recognized";
  }

  if (TOLERATED_TAGS.has(tag)) {
    return "tolerated";
  }

  return "unknown";
}

// A simple DOM path segment for an element among its siblings, adding `:nth-of-type(n)` only when it
// shares its tag with a sibling (e.g. `div:nth-of-type(2)`).
function segmentFor(element: Element, parent: Element): string {
  const tag = element.tagName.toLowerCase();
  const sameType = Array.from(parent.children).filter(
    (sibling) => sibling.tagName === element.tagName
  );

  if (sameType.length === 1) {
    return tag;
  }

  return `${tag}:nth-of-type(${sameType.indexOf(element) + 1})`;
}

// Every attribute of an element as a plain record, for the evidence log.
function attributesOf(element: Element): Record<string, string> {
  const attributes: Record<string, string> = {};

  for (const attribute of Array.from(element.attributes)) {
    attributes[attribute.name] = attribute.value;
  }

  return attributes;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function siblingText(node: ChildNode | null): string {
  if (node === null) {
    return "";
  }

  return String(node.textContent);
}

// Trimmed, truncated text of the previous and next siblings, to give an unknown element's evidence a
// human-readable anchor in the surrounding prose.
function adjacentText(element: Element): string {
  const surrounding = [siblingText(element.previousSibling), siblingText(element.nextSibling)];

  return collapseWhitespace(surrounding.join(" ")).slice(0, ADJACENT_TEXT_LIMIT);
}

// A body-rooted DOM path for an element (e.g. `body>pre>a:nth-of-type(2)`), for the evidence log.
// Every element reached here lives inside `body`, so the ascent always terminates at the `body` tag.
function pathOf(element: Element): string {
  const segments: string[] = [];
  let current = element;

  while (current.tagName.toLowerCase() !== "body") {
    const parent = current.parentElement as Element;
    segments.unshift(segmentFor(current, parent));
    current = parent;
  }

  return ["body", ...segments].join(">");
}

// --- Code-listing callout markers (#336) ------------------------------------------------------
//
// O'Reilly code listings annotate specific lines with inline callout markers (❶ ❷ ❸ …) — typically an
// `<a><img alt="N"></a>` inside the `<pre>` — paired with a numbered explanation list below. Because
// `codeBlock` is `text*` (no inline atoms, and no schema change here), ProseMirror's DOMParser would
// otherwise close the code block at the first marker and auto-wrap the `<img>` in a `figure`, sweeping
// the following code lines in as a centered caption — shattering the listing. So BEFORE parsing we
// replace each inline marker with a plain-text circled-number glyph at its exact position; the `<pre>`
// then parses to a single cohesive `codeBlock` with every line and marker preserved.

// Filled (negative) circled-number glyphs: ❶..❿ (U+2776..U+277F, 1..10) and ⓫..⓴ (U+24EB..U+24F4,
// 11..20). There is no single glyph beyond 20, so callers parenthesize the number instead.
function calloutGlyph(value: number): string | undefined {
  if (value >= 1 && value <= 10) {
    return String.fromCodePoint(0x2775 + value);
  }

  if (value >= 11 && value <= 20) {
    return String.fromCodePoint(0x24eb + (value - 11));
  }

  return undefined;
}

// Whether a label is already one of the circled-number glyphs this normalizer emits (1..20), so a
// marker whose text is a pre-existing glyph is kept verbatim rather than parenthesized.
function isCircledNumberGlyph(label: string): boolean {
  for (let value = 1; value <= 20; value += 1) {
    if (calloutGlyph(value) === label) {
      return true;
    }
  }

  return false;
}

// Parse a label that is entirely digits into a positive integer, else undefined.
function positiveInteger(label: string): number | undefined {
  if (!/^\d+$/.test(label)) {
    return undefined;
  }

  const value = Number.parseInt(label, 10);

  return value >= 1 ? value : undefined;
}

// A callout number as text: its circled glyph, or a parenthesized number beyond the glyph range.
function numberedCalloutText(value: number): string {
  return calloutGlyph(value) ?? `(${value})`;
}

// The inline text that replaces a callout marker, from its label and 1-based document order: a numeric
// label maps to its circled glyph (a parenthesized number beyond the glyph range); a non-numeric label
// is shown parenthesized (a pre-existing circled glyph kept as-is); an EMPTY label cannot be read
// faithfully, so it recovers to the order glyph AND flags evidence (fail-loud — never vanish/shatter).
function calloutReplacement(label: string, order: number): { text: string; unreadable: boolean } {
  const numbered = positiveInteger(label);

  if (numbered !== undefined) {
    return { text: numberedCalloutText(numbered), unreadable: false };
  }

  if (label !== "") {
    return { text: isCircledNumberGlyph(label) ? label : `(${label})`, unreadable: false };
  }

  return { text: numberedCalloutText(order), unreadable: true };
}

// An element attribute as a string, treating an absent attribute as empty — one place for the
// null-normalization so callout predicates below read plain strings (keeps branch coverage exact).
function attr(element: Element, name: string): string {
  const value = element.getAttribute(name);

  return value === null ? "" : value;
}

// Whether a class attribute carries the O'Reilly callout token `co`.
function hasCalloutClass(className: string): boolean {
  return className.split(/\s+/).includes("co");
}

// Whether an `<img>` is a callout image: a numeric `alt`, a `callouts/…` src, or the `co` class.
function isCalloutImage(image: Element): boolean {
  return (
    positiveInteger(attr(image, "alt").trim()) !== undefined ||
    /callout/i.test(attr(image, "src")) ||
    hasCalloutClass(attr(image, "class"))
  );
}

// Whether an `<a>` wraps a callout: the `co` class, an `#co…` href, or a nested callout image.
function isCalloutAnchor(anchor: Element): boolean {
  if (hasCalloutClass(attr(anchor, "class")) || attr(anchor, "href").startsWith("#co")) {
    return true;
  }

  const innerImage = anchor.querySelector("img");

  return innerImage !== null && isCalloutImage(innerImage);
}

// Whether an `<a>` / `<img>` / `<span>` inside a `<pre>` is a callout marker to normalize.
function isPreCalloutMarker(element: Element): boolean {
  const tag = element.tagName.toLowerCase();

  if (tag === "a") {
    return isCalloutAnchor(element);
  }

  if (tag === "img") {
    return isCalloutImage(element);
  }

  return hasCalloutClass(attr(element, "class"));
}

// The callout markers within a `<pre>`, in document order, each taken at its outermost element so a
// wrapping `<a>` and its nested `<img>` count once (the inner image is skipped as already contained).
function collectPreMarkers(pre: Element): Element[] {
  const markers: Element[] = [];

  for (const candidate of Array.from(pre.querySelectorAll("a, img, span"))) {
    if (markers.some((marker) => marker.contains(candidate))) {
      continue;
    }

    if (isPreCalloutMarker(candidate)) {
      markers.push(candidate);
    }
  }

  return markers;
}

// A marker's label to interpret: an `<img>`'s own `alt`, else a wrapped image's `alt`, else its text.
function markerLabel(marker: Element): string {
  if (marker.tagName.toLowerCase() === "img") {
    return attr(marker, "alt").trim();
  }

  const innerImage = marker.querySelector("img");

  if (innerImage !== null) {
    const alt = attr(innerImage, "alt").trim();

    if (alt !== "") {
      return alt;
    }
  }

  return String(marker.textContent).trim();
}

// Replace every inline callout marker inside each `<pre>` with its plain-text circled-number glyph, so
// the code block parses cohesively. An unreadable marker still resolves (by document order) but records
// evidence, keeping the fail-loud invariant.
function normalizeCodeCallouts(body: HTMLElement, ownerDocument: Document): IngestionEvidence[] {
  const evidence: IngestionEvidence[] = [];

  for (const pre of Array.from(body.querySelectorAll("pre"))) {
    collectPreMarkers(pre).forEach((marker, index) => {
      const { text, unreadable } = calloutReplacement(markerLabel(marker), index + 1);

      if (unreadable) {
        evidence.push({
          adjacentText: adjacentText(marker),
          attributes: attributesOf(marker),
          path: pathOf(marker),
          tag: marker.tagName.toLowerCase()
        });
      }

      marker.replaceWith(ownerDocument.createTextNode(text));
    });
  }

  return evidence;
}

// The href an SVG `<image>` points at: EPUB diagrams commonly reference a raster through
// `xlink:href` (the SVG 1.1 form) or a bare `href` (SVG 2). Returns the first non-empty one.
function svgImageHref(image: Element): string | null {
  const href = image.getAttribute("xlink:href") ?? image.getAttribute("href");

  return href === null || href === "" ? null : href;
}

// EPUB publishers frequently wrap a raster diagram as `<svg><image xlink:href="…"/></svg>` (the DDIA
// pattern) rather than a bare `<img>`. The #310 schema models a raster figure as `<img>`, and `<svg>`
// is otherwise an unrecognized block the fail-loud walk would flag. So BEFORE the walk, unwrap every
// SVG that carries an `<image>` into a plain `<img>` bearing that reference, so it parses as a figure
// image like any other raster. A pure-vector `<svg>` (no `<image>`, or an `<image>` with no usable
// href) is a different construct, out of scope here, and left for the fail-loud walk to record.
function normalizeSvgImages(body: HTMLElement, ownerDocument: Document): void {
  for (const svg of Array.from(body.querySelectorAll("svg"))) {
    const image = svg.querySelector("image");

    if (image === null) {
      continue;
    }

    const href = svgImageHref(image);

    if (href === null) {
      continue;
    }

    const img = ownerDocument.createElement("img");
    img.setAttribute("src", href);
    const alt = image.getAttribute("alt") ?? svg.getAttribute("aria-label");

    if (alt !== null) {
      img.setAttribute("alt", alt);
    }

    svg.replaceWith(img);
  }
}

// The inline-content blocks whose content model is `inline*` (no room for a block-level figure/image):
// an `<img>` living directly in one of these has no schema home. They split into two kinds:
// STANDALONE-capable hosts (`<p>` and headings) where an image that is the host's SOLE content lifts
// cleanly into a top-level standalone figure (safe, no loss); and CHILD-only containers (`<figcaption>`,
// `<dt>`) nested inside another block, where even a sole image is mangled — it is promoted out to a
// spurious sibling figure, leaving the caption/term empty. An image alongside real text is inline-lost
// in either kind.
const STANDALONE_IMAGE_HOSTS = "p,h1,h2,h3,h4,h5,h6";
const INLINE_CONTENT_HOSTS = `${STANDALONE_IMAGE_HOSTS},figcaption,dt`;
const CHILD_ONLY_INLINE_HOSTS = new Set(["figcaption", "dt"]);

// Make inline-image loss LOUD (#523). An `<img>`/`<svg><image>` (already normalized to `<img>`) with no
// schema home is recorded as fail-loud evidence and removed BEFORE the parse (and after
// `normalizeSvgImages`), so the surrounding prose survives intact instead of ProseMirror silently
// splitting the block and folding prose into a spurious caption. An `image` node is valid only inside a
// block-level `figure`, and #368 keeps inline runs mark-based to avoid the #340 CJK shatter. Two cases
// are caught: (1) an image alongside real text in any inline-content host (mid-paragraph/caption/term);
// (2) a SOLE image inside a child-only container (`<figcaption>`/`<dt>`), which cannot become a
// standalone figure and would be mangled out of its parent. A sole image in a standalone-capable host
// (`<p>`/heading) or at body/`<div>` level still becomes a clean figure and is left alone; images inside
// `<pre>`/`<code>` keep their existing handling (callout normalization).
function collectInlineImageLoss(body: HTMLElement): IngestionEvidence[] {
  const evidence: IngestionEvidence[] = [];

  for (const img of Array.from(body.querySelectorAll("img"))) {
    if (img.closest("pre,code") !== null) {
      continue;
    }

    const host = img.closest(INLINE_CONTENT_HOSTS);

    if (host === null) {
      continue;
    }

    // An image alongside real text is inline-lost in any host. A SOLE image (no sibling text — an
    // `<img>` contributes none) is lost only in a child-only container that cannot host a standalone
    // figure; in a `<p>`/heading it lifts cleanly into a top-level figure, so it is left alone.
    const hostHasText = String(host.textContent).trim().length > 0;
    const isChildOnlyHost = CHILD_ONLY_INLINE_HOSTS.has(host.tagName.toLowerCase());
    if (!hostHasText && !isChildOnlyHost) {
      continue;
    }

    evidence.push({
      adjacentText: adjacentText(img),
      attributes: attributesOf(img),
      path: pathOf(img),
      tag: "img"
    });
    img.remove();
  }

  return evidence;
}

// Replace an unrecognized element with a sentinel `<div>` that preserves its original tag and raw
// HTML verbatim, so the explicit `unknown` parse rule turns it into an `unknown` node (and the
// pre-walk does not descend into it).
function replaceWithSentinel(element: Element, ownerDocument: Document): void {
  const sentinel = ownerDocument.createElement("div");

  sentinel.setAttribute("data-whetstone-unknown", "true");
  sentinel.setAttribute("data-tag", element.tagName.toLowerCase());
  sentinel.setAttribute("data-raw", element.outerHTML);
  element.replaceWith(sentinel);
}

// Depth-first pre-walk of the body subtree: descend through recognized and tolerated elements, and
// for every unknown element record an evidence entry and replace it with a sentinel before parsing.
function collectUnknowns(body: HTMLElement, ownerDocument: Document): IngestionEvidence[] {
  const evidence: IngestionEvidence[] = [];

  function walk(element: Element, path: string): void {
    const children = Array.from(element.children).map((child) => ({
      child,
      childPath: `${path}>${segmentFor(child, element)}`
    }));

    for (const { child, childPath } of children) {
      // MathML is a structured subtree of its own unrecognized elements (mrow/mi/mo/mn/msup/...).
      // Descending would classify those children as unknown and shatter the surrounding paragraph
      // (like #357's `<tt>`), and tolerating `math` as a descent tag would do the same. So handle
      // `<math>` as an atom: replace it with a text node of its concatenated symbols and never walk
      // its internals. v0 shows the formula's symbols inline; true MathML rendering is deferred (#361).
      if (child.tagName.toLowerCase() === MATH_TAG) {
        child.replaceWith(ownerDocument.createTextNode(child.textContent as string));
        continue;
      }

      if (classify(child) === "unknown") {
        evidence.push({
          adjacentText: adjacentText(child),
          attributes: attributesOf(child),
          path: childPath,
          tag: child.tagName.toLowerCase()
        });
        replaceWithSentinel(child, ownerDocument);
        continue;
      }

      walk(child, childPath);
    }
  }

  walk(body, "body");

  return evidence;
}

// Recursively remove the `anchorId` block-group attribute from a node's JSON (and its descendants),
// returning a copy. `anchorId` rides the parse only as a lift carrier: it is addressing metadata, not
// render content, so the stored `doc_blocks.node_json` must not carry it — keeping the node JSON
// byte-identical to before this attribute existed (#366).
function stripAnchorId(node: DocumentNodeJSON): DocumentNodeJSON {
  const next: DocumentNodeJSON = { ...node };

  if (next.attrs !== undefined && "anchorId" in next.attrs) {
    const { anchorId: _anchorId, ...rest } = next.attrs;
    next.attrs = rest;
  }

  if (next.content !== undefined) {
    next.content = next.content.map(stripAnchorId);
  }

  return next;
}

// Top-level blocks always carry an id after `assignNodeIds`, so read it through a typed view rather
// than an optional chain whose null branch could never be taken (keeps branch coverage exact). The
// block's source-HTML `anchorId` is lifted off the top-level node and the attribute stripped from the
// stored JSON, so the id becomes the `doc_blocks.anchor_id` addressing column (#366).
function toBlock(node: DocumentNodeJSON): IngestedBlock {
  const attrs = node.attrs as Record<string, unknown>;
  const anchorIdValue = attrs["anchorId"];
  const anchorId = typeof anchorIdValue === "string" ? anchorIdValue : null;

  return { anchorId, id: String(attrs["id"]), node: stripAnchorId(node), type: node.type };
}

// --- CJK inter-character spacing (#340) -------------------------------------------------------
//
// Public-domain digitized Chinese EPUBs carry stray ASCII spaces between Han characters at the
// original scan's line-wrap points (e.g. `以合六 爻之变`). Chinese has no inter-word spaces, so such a
// space is pure digitization noise that renders as a visible mid-phrase gap. We strip it at ingestion
// — standard CJK microtypography — while preserving every meaningful space (Latin/digit-adjacent, or
// inside verbatim code). Non-destructive: the raw EPUB is retained, so this is regenerable and not a
// fidelity violation (a space between two Han characters is not a publisher construct).

// CJK-class characters: Han ideographs (all planes) plus CJK/fullwidth punctuation (《 》 ， 。 、 ； ：
// （ ） 「 」 …). The ideographic space U+3000 is deliberately excluded (it can be intentional
// indentation), so the punctuation range starts at U+3001.
const CJK_CLASS = "\\p{Script=Han}\\u3001-\\u303F\\uFE30-\\uFE4F\\uFF00-\\uFFEF";

// A run of ASCII whitespace flanked by CJK-class characters on both sides. The trailing character is
// matched by lookahead so it can also open the next run (handles chains like `六 爻 之` and `六  爻`).
const INTER_CJK_SPACE = new RegExp(`([${CJK_CLASS}])[\\t\\n\\v\\f\\r ]+(?=[${CJK_CLASS}])`, "gu");

// Remove stray ASCII spaces between CJK characters, leaving every other space untouched.
function stripInterCjkSpace(text: string): string {
  return text.replace(INTER_CJK_SPACE, "$1");
}

// DOM node type for a text node (jsdom follows the DOM spec: Text === 3).
const TEXT_NODE = 3;

// Normalize stray inter-CJK ASCII spaces in every text node before parsing, skipping `<pre>`/`<code>`
// subtrees where whitespace is significant. Emits no evidence — scan-noise spacing is not a construct.
function normalizeCjkSpacing(element: Element): void {
  const tag = element.tagName.toLowerCase();

  if (tag === "pre" || tag === "code") {
    return;
  }

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === TEXT_NODE) {
      child.nodeValue = stripInterCjkSpace(String(child.nodeValue));
    }
  }

  for (const child of Array.from(element.children)) {
    normalizeCjkSpacing(child);
  }
}

// DOM node type for an element (jsdom follows the DOM spec: Element === 1).
const ELEMENT_NODE = 1;

// The within-text-node pass above misses a stray space that STRADDLES an inline element (#358): in
// `使用 <b>传硕计划</b> 中`, the flanking spaces live in different text nodes (`使用 ` / ` 中`) whose
// neighbouring Han lives across the `<b>`, so the per-node lookahead never sees a CJK on the far side.
// The tags whose boundary keeps text in one inline flow (so a space across them is still inter-CJK).
// `code`/`pre` (whitespace significant), `br` (a line break), and every block/container tag are NOT
// here — they end the inline run, and a space is never joined across a block boundary.
const INLINE_FLOW_TAGS = new Set<string>([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "big",
  "cite",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "wbr"
]);

// Matches a single CJK-class code point (the same class the within-node pass uses), so surrogate-pair
// Han (astral planes) is matched as one character.
const CJK_CHAR = new RegExp(`^[${CJK_CLASS}]$`, "u");
const TRAILING_ASCII_SPACE = /[\t\n\v\f\r ]+$/;
const LEADING_ASCII_SPACE = /^[\t\n\v\f\r ]+/;

function isCjkChar(char: string | undefined): boolean {
  // `String(undefined)` -> "undefined" (a multi-char string) never matches the single-code-point class,
  // so an all-whitespace boundary (no real character) is simply not CJK — no separate undefined branch.
  return CJK_CHAR.test(String(char));
}

// The last / first character of a string ignoring a trailing / leading ASCII-whitespace run, by code
// point (so astral Han is whole), or undefined when the string is empty/all-whitespace.
function lastNonSpaceChar(text: string): string | undefined {
  return [...text.replace(TRAILING_ASCII_SPACE, "")].at(-1);
}

function firstNonSpaceChar(text: string): string | undefined {
  return [...text.replace(LEADING_ASCII_SPACE, "")][0];
}

// One inline-flow run of text nodes (in document order). At each junction, when the run's last real
// character before the gap and the first real character after it are BOTH CJK, the gap's ASCII spaces
// (the left node's trailing run and the right node's leading run) are digitization noise and removed;
// a Latin/digit on either side keeps the space, and U+3000 is never an ASCII space so it is untouched.
function trimInlineBoundaries(segment: ReadonlyArray<Text>): void {
  let previous: Text | undefined;

  for (const node of segment) {
    if (previous !== undefined) {
      const leftText = String(previous.nodeValue);
      const rightText = String(node.nodeValue);

      if (isCjkChar(lastNonSpaceChar(leftText)) && isCjkChar(firstNonSpaceChar(rightText))) {
        previous.nodeValue = leftText.replace(TRAILING_ASCII_SPACE, "");
        node.nodeValue = rightText.replace(LEADING_ASCII_SPACE, "");
      }
    }

    previous = node;
  }
}

// Strip inter-CJK ASCII spaces that straddle inline element boundaries (#358). Walks in document order,
// collecting each maximal inline-flow run of text nodes (descending through inline formatting tags) and
// trimming its junctions; a block element, `<br>`, `<pre>`, or `<code>` ends the current run so the
// join never crosses a block boundary or verbatim code.
function joinInlineCjkSpacing(root: Element): void {
  let segment: Text[] = [];

  function flush(): void {
    trimInlineBoundaries(segment);
    segment = [];
  }

  function walk(element: Element): void {
    for (const child of Array.from(element.childNodes)) {
      if (child.nodeType === TEXT_NODE) {
        segment.push(child as Text);
        continue;
      }

      if (child.nodeType !== ELEMENT_NODE) {
        // A comment / processing instruction is invisible: it neither contributes text nor breaks flow.
        continue;
      }

      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      if (INLINE_FLOW_TAGS.has(tag)) {
        walk(el);
        continue;
      }

      // A block boundary, <br>, <pre>, or <code>: end the current inline run. A block's own inline
      // flows are collected on their own; verbatim code is never descended into.
      flush();
      if (tag !== "pre" && tag !== "code") {
        walk(el);
      }
      flush();
    }
  }

  walk(root);
  flush();
}

// --- Section-wrapper anchor hoist (#516) ------------------------------------------------------
//
// Section/subsection fragment ids are commonly authored on a STRUCTURAL WRAPPER element
// (`<div class="sect1" id="…">`, `<section id="…">` — the O'Reilly / HTMLBook / DocBook-HTML
// convention) that encloses the section's heading and prose. Those wrappers are tolerated containers
// unwrapped at parse time, so `withAnchorId` never captures their id and the section anchor is lost —
// a 目录 section link then takes the fragment-miss fallback to the unit top (#495). BEFORE parsing,
// hoist each wrapper id onto the first block-level descendant that lacks its own id (its leading
// block — usually the heading), so the section resolves through the work anchor index (#366) to that
// block. This only MOVES an `id` attribute: rendered text (the plaintext==textContent contract) is
// unchanged.

// Structural container tags whose id we hoist — a subset of the tolerated container tags. Inline
// tolerated tags (span/a/em/…) are deliberately excluded: their id is an inline-level anchor, not a
// section wrapper, and must not jump to a block.
const HOISTABLE_WRAPPER_TAGS = new Set<string>([
  "div",
  "section",
  "article",
  "aside",
  "main",
  "header",
  "footer",
  "nav"
]);

// Block-level tags that become a top-level block owning an `anchorId` — the valid hoist targets.
// Mirrors the block-group parse rules (headings, paragraph, blockquote, code, lists, table, figure,
// definition list). Callouts and footnote targets are block-level too, matched by `data-type` below.
const BLOCK_LEVEL_TAGS = new Set<string>([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "blockquote",
  "pre",
  "ul",
  "ol",
  "table",
  "figure",
  "dl"
]);

// Does `element` become its own top-level block (and thus already carry / can carry an anchor)? A
// block tag, or a callout/footnote-target `data-type` element (noteref is an inline marker, not a
// block, so it is excluded).
function isBlockLevelElement(element: Element): boolean {
  const dataType = element.getAttribute("data-type");
  if (dataType !== null && RECOGNIZED_DATA_TYPES.has(dataType) && dataType !== "noteref") {
    return true;
  }
  return BLOCK_LEVEL_TAGS.has(element.tagName.toLowerCase());
}

// A structural wrapper whose id should hoist: a container tag carrying an id that is not itself a
// block (e.g. NOT a `<div data-type="note">` callout, which already captures its own id).
function isHoistableWrapper(element: Element): boolean {
  return (
    element.hasAttribute("id") &&
    HOISTABLE_WRAPPER_TAGS.has(element.tagName.toLowerCase()) &&
    !isBlockLevelElement(element)
  );
}

// Number of ancestor elements — the DOM depth, used to process innermost wrappers first.
function elementDepth(element: Element): number {
  let depth = 0;
  let current = element.parentElement;
  while (current !== null) {
    depth += 1;
    current = current.parentElement;
  }
  return depth;
}

// Hoist each structural-wrapper id onto its leading block. Innermost wrappers are processed first
// (greatest depth) so a nested `sect1` claims its own leading block before an enclosing chapter/part
// wrapper, which then adopts the next id-less block — nested wrappers map to DISTINCT blocks and the
// more specific inner id wins. A block that already has its own id is never overwritten (skipped as
// "not id-less"). When a wrapper's anchor CANNOT be carried by any block — no id-less block descendant
// exists, whether because the wrapper holds only inline content, only a standalone image/embed, only a
// textless unknown construct (`<video>`/`<canvas>`/pure-vector `<svg>`), or block descendants that
// already carry their own ids (a co-anchored nesting; a block carries a single anchor, so the outer id
// has nowhere to land) — the anchor is genuinely lost, so ingestion records fail-loud evidence rather
// than dropping it silently (#523 wrapper-metadata category). Only a truly empty or purely decorative
// anchored wrapper (nothing to address — no text, all-`tolerated` descendants) drops quietly.
// Idempotent enough for the pipeline: it runs once before parsing and only moves attributes.
function hoistWrapperAnchorIds(body: HTMLElement): IngestionEvidence[] {
  const evidence: IngestionEvidence[] = [];
  const wrappers = Array.from(body.querySelectorAll("*")).filter(isHoistableWrapper);
  wrappers.sort((first, second) => elementDepth(second) - elementDepth(first));

  for (const wrapper of wrappers) {
    const wrapperId = wrapper.getAttribute("id") as string;
    const descendants = Array.from(wrapper.querySelectorAll("*"));
    const target = descendants.find(
      (descendant) => isBlockLevelElement(descendant) && !descendant.hasAttribute("id")
    );
    if (target === undefined) {
      // No id-less block can carry this anchor. The wrapper addressed real content — so its lost anchor
      // is made loud — unless it is empty or purely decorative. "Empty/decorative" is defined
      // generally: no non-whitespace text, and every descendant is a `tolerated` element (a structural
      // wrapper, inline formatting, or a decorative `<hr>`/`<br>` — none of which yields a block or
      // evidence on its own). Any `recognized` (block-producing) or `unknown` (evidence-producing)
      // descendant — a heading whose id is taken, an `<img>`/`<svg>`, a `<video>`/`<canvas>`, etc. —
      // means the wrapper addressed content the tolerated element cannot, so the dropped id is loud.
      const enclosesContent =
        String(wrapper.textContent).trim().length > 0 ||
        descendants.some((descendant) => classify(descendant) !== "tolerated");
      if (enclosesContent) {
        evidence.push({
          adjacentText: adjacentText(wrapper),
          attributes: attributesOf(wrapper),
          path: pathOf(wrapper),
          tag: wrapper.tagName.toLowerCase()
        });
      }
      continue;
    }
    target.setAttribute("id", wrapperId);
    wrapper.removeAttribute("id");
  }

  return evidence;
}

// Convert one source HTML fragment into a whetstone document, its block-row decomposition, and the
// fail-loud evidence log of unrecognized elements.
export function htmlToDocument(html: string): HtmlIngestionResult {
  const { window } = new JSDOM(html);
  const { body } = window.document;
  // Hoist section-wrapper ids onto their leading block BEFORE any other walk or the parse, so a
  // fragment authored on a `<div class="sect1" id>` / `<section id>` becomes a block `anchorId` (#516)
  // instead of being dropped when the wrapper is unwrapped; an anchor that genuinely cannot be carried
  // (inline-only content, no block to hold it) surfaces as fail-loud evidence (#523).
  const wrapperEvidence = hoistWrapperAnchorIds(body);
  // Unwrap `<svg><image xlink:href>` raster wrappers (the DDIA diagram pattern) into plain `<img>`
  // BEFORE the fail-loud walk, so they model as figure images instead of flagging `<svg>` as unknown.
  normalizeSvgImages(body, window.document);
  // Make inline-image loss loud (#523): record evidence for and remove any `<img>` in inline flow
  // (mid-paragraph/caption alongside text), which the schema cannot represent and which would
  // otherwise silently shatter its paragraph. Runs after `normalizeSvgImages` so SVG-wrapped rasters
  // are already `<img>`, and before the callout/unknown walks so a removed image is not re-walked.
  const inlineImageEvidence = collectInlineImageLoss(body);
  // Normalize code-listing callout markers to inline text BEFORE the fail-loud walk and the parse, so
  // a `<pre>` with inline `<a>`/`<img>` markers parses to one cohesive `codeBlock` (#336).
  const calloutEvidence = normalizeCodeCallouts(body, window.document);
  const evidence = [
    ...wrapperEvidence,
    ...inlineImageEvidence,
    ...calloutEvidence,
    ...collectUnknowns(body, window.document)
  ];
  // Strip stray inter-CJK digitization spaces from text nodes (skipping code) before parsing (#340),
  // then the spaces that straddle an inline element boundary (#358), so an emphasized/linked term
  // mid-phrase (`使用 <b>传硕计划</b> 中`) does not leave a visible gap.
  normalizeCjkSpacing(body);
  joinInlineCjkSpacing(body);
  const parsed = new DOMParser(documentSchema, RULES).parse(body);
  const doc = assignNodeIds(serializeDocument(parsed));
  const blocks = (doc.content as DocumentNodeJSON[]).map(toBlock);

  return { blocks, doc, evidence };
}
