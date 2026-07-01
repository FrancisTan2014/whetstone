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

// One top-level block of the ingested document: its stable id, node type, and the ProseMirror node
// JSON to persist as a Block row.
export interface IngestedBlock {
  id: string;
  type: string;
  node: DocumentNodeJSON;
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

// A footnote marker references its target by `refId`: a same-document `href="#id"`, else an explicit
// `data-target`, else null (an out-of-document endnote the reader slice resolves separately).
function readRefId(element: HTMLElement): string | null {
  const href = element.getAttribute("href");

  if (href !== null && href.startsWith("#")) {
    return href.slice(1);
  }

  return element.getAttribute("data-target");
}

function readFootnoteMarkerAttrs(element: HTMLElement): {
  label: string;
  noteKind: string;
  refId: string | null;
} {
  return { label: elementText(element), noteKind: "footnote", refId: readRefId(element) };
}

function readFootnoteTargetAttrs(element: HTMLElement): { refId: string | null } {
  return { refId: element.getAttribute("id") };
}

// The unknown fallback reads back the raw HTML and original tag the pre-walk stamped onto the
// sentinel, so the publisher construct is preserved verbatim in the model.
function readUnknownAttrs(element: HTMLElement): { html: string | null; tag: string | null } {
  return { html: element.getAttribute("data-raw"), tag: element.getAttribute("data-tag") };
}

// One parse rule per heading level so the level is a static attr rather than a parsed one.
const headingRules: ParseRule[] = [1, 2, 3, 4, 5, 6].map((level) => ({
  attrs: { level },
  node: "heading",
  tag: `h${level}`
}));

// One parse rule per callout kind, each stamping the kind from its `data-type`.
const calloutRules: ParseRule[] = CALLOUT_KINDS.map((kind) => ({
  getAttrs: readCalloutAttrs,
  node: "callout",
  tag: `div[data-type=${kind}]`
}));

// The explicit rules array bound to `documentSchema`'s node types (see file header for why this is
// not `DOMParser.fromSchema`). Order matters only where selectors overlap; here they are disjoint.
const RULES: ParseRule[] = [
  ...headingRules,
  { node: "paragraph", tag: "p" },
  { node: "blockquote", tag: "blockquote" },
  {
    getAttrs: (element) => ({ language: readCodeLanguage(element) }),
    node: "codeBlock",
    preserveWhitespace: "full",
    tag: "pre"
  },
  { node: "bulletList", tag: "ul" },
  { getAttrs: readOrderedListAttrs, node: "orderedList", tag: "ol" },
  { node: "listItem", tag: "li" },
  { node: "table", tag: "table" },
  { node: "tableRow", tag: "tr" },
  { getAttrs: readCellAttrs, node: "tableCell", tag: "td" },
  { getAttrs: readCellAttrs, node: "tableHeader", tag: "th" },
  { node: "figure", tag: "figure" },
  { getAttrs: readImageAttrs, node: "image", tag: "img" },
  { node: "figureCaption", tag: "figcaption" },
  { node: "definitionList", tag: "dl" },
  { node: "definitionTerm", tag: "dt" },
  { node: "definitionDescription", tag: "dd" },
  ...calloutRules,
  { getAttrs: readFootnoteMarkerAttrs, node: "footnoteMarker", tag: "a[data-type=noteref]" },
  { getAttrs: readFootnoteTargetAttrs, node: "footnoteTarget", tag: "[data-type=footnote]" },
  { getAttrs: readUnknownAttrs, node: "unknown", tag: "div[data-whetstone-unknown]" }
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

// Top-level blocks always carry an id after `assignNodeIds`, so read it through a typed view rather
// than an optional chain whose null branch could never be taken (keeps branch coverage exact).
function toBlock(node: DocumentNodeJSON): IngestedBlock {
  const attrs = node.attrs as Record<string, unknown>;

  return { id: String(attrs["id"]), node, type: node.type };
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

// Convert one source HTML fragment into a whetstone document, its block-row decomposition, and the
// fail-loud evidence log of unrecognized elements.
export function htmlToDocument(html: string): HtmlIngestionResult {
  const { window } = new JSDOM(html);
  const { body } = window.document;
  // Normalize code-listing callout markers to inline text BEFORE the fail-loud walk and the parse, so
  // a `<pre>` with inline `<a>`/`<img>` markers parses to one cohesive `codeBlock` (#336).
  const calloutEvidence = normalizeCodeCallouts(body, window.document);
  const evidence = [...calloutEvidence, ...collectUnknowns(body, window.document)];
  // Strip stray inter-CJK digitization spaces from text nodes (skipping code) before parsing (#340).
  normalizeCjkSpacing(body);
  const parsed = new DOMParser(documentSchema, RULES).parse(body);
  const doc = assignNodeIds(serializeDocument(parsed));
  const blocks = (doc.content as DocumentNodeJSON[]).map(toBlock);

  return { blocks, doc, evidence };
}
