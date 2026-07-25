import {
  documentText,
  parseDocument,
  serializeDocument,
  type DocumentMarkJSON,
  type DocumentNodeJSON
} from "./document.js";

// The canonical semantic projection of a body-bearing Note's document — the single identity surface for
// "is this the same material?" (#711). It is a PURE, deterministic string derived only from the meaning a
// reader would perceive, with every renderer-equivalent or addressing-only difference normalized away, so
// two documents that a person would read as the same content project to the same string (and any semantic
// difference — a changed word, case, symbol, link destination, code, or structure — projects differently).
//
// It is DELIBERATELY not a hash and not a stored value: the SHA-256 fingerprint derived from it (server-side)
// is only a lookup accelerator, and equality is always decided by comparing this projected string in full.
// Kept in the browser-safe document package with no Node APIs, so backfill, the write boundary, and the
// owner-scoped equality query all COMPOSE this one projection instead of re-deriving identity per surface.

// Addressing-only attributes carry no material meaning — a generated node id or a source-HTML anchor id is
// where a block lives, not what it says — so they are stripped before projecting.
const ADDRESSING_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set(["id", "anchorId"]);

// Bold/italic are presentation the identity surface ignores (PRODUCT: emphasis is not content); every other
// mark — inline code and links with their destinations — is preserved because it changes meaning.
const PRESENTATION_MARK_NAMES: ReadonlySet<string> = new Set(["bold", "italic"]);

// Nodes whose content is a single inline run (text + inline atoms); everything else is a block container
// whose children are themselves blocks. Mirrors the reader/text projection's inline-content set.
const INLINE_CONTENT_NODE_TYPES: ReadonlySet<string> = new Set([
  "paragraph",
  "heading",
  "codeBlock",
  "figureCaption",
  "definitionTerm"
]);

// Nodes whose text is OPAQUE — its whitespace is content (source code), so it is never collapsed like prose.
const OPAQUE_TEXT_NODE_TYPES: ReadonlySet<string> = new Set(["codeBlock"]);

// Inline atoms and block leaves whose mere presence is material, so a document carrying one is never "blank"
// even when it holds no readable text (a lone image, a raw-HTML unknown, or a footnote reference).
const SEMANTIC_ATOM_NODE_TYPES: ReadonlySet<string> = new Set([
  "image",
  "unknown",
  "footnoteMarker"
]);

// A stable, self-describing tree of JSON primitives and arrays — never a plain object — so serializing it is
// deterministic without depending on object key order.
type CanonicalValue = string | number | boolean | null | CanonicalValue[];

// A single mark projected canonically: its type plus its sorted, addressing-free attributes.
type CanonicalMark = [string, CanonicalValue];

// Raised when a body-bearing Note's document carries no material at all — every prose run is blank and it
// holds no semantic atom — so there is nothing to identify. Callers fail loudly BEFORE hashing rather than
// minting a fingerprint over emptiness.
export class BlankNoteMaterialError extends Error {
  constructor() {
    super("A body-bearing note document must carry material to project; this document is blank.");
    this.name = "BlankNoteMaterialError";
  }
}

// A string attribute value is NFC-normalized so canonically-equivalent Unicode (e.g. NFD combining marks)
// projects identically; every other primitive is kept verbatim so numbers/booleans/null stay exact.
function canonicalAttributeValue(value: unknown): CanonicalValue {
  return typeof value === "string" ? value.normalize("NFC") : (value as CanonicalValue);
}

// An attribute map projected to a sorted list of `[key, value]` pairs: addressing-only keys dropped, string
// values NFC-normalized, keys sorted (all schema attribute keys are ASCII) so the source object's key order
// can never change the projection.
function canonicalAttributes(attrs: Record<string, unknown> | undefined): CanonicalValue {
  return Object.entries(attrs ?? {})
    .filter(([key]) => !ADDRESSING_ATTRIBUTE_NAMES.has(key))
    .map(([key, value]): [string, CanonicalValue] => [key, canonicalAttributeValue(value)])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

// A text run's marks projected canonically: presentation (bold/italic) removed, each surviving mark reduced
// to its type + canonical attributes. The schema lets at most one non-presentation mark survive on a run
// (inline code excludes every other mark, and a run carries a single link), so no ordering is needed. The
// result doubles as the run's identity key when merging adjacent equal-marked runs.
function canonicalMarks(marks: DocumentMarkJSON[] | undefined): CanonicalMark[] {
  return (marks ?? [])
    .filter((mark) => !PRESENTATION_MARK_NAMES.has(mark.type))
    .map((mark): CanonicalMark => [mark.type, canonicalAttributes(mark.attrs)]);
}

// Whether a run's surviving marks include inline `code`; a code run's whitespace is opaque even inside a
// prose block, so it is never collapsed.
function marksAreCode(marks: CanonicalMark[]): boolean {
  return marks.some((mark) => mark[0] === "code");
}

// One item of an inline run: a text segment with its canonical marks and opacity, or a nested inline atom.
type TextItem = {
  kind: "text";
  marks: CanonicalMark[];
  marksKey: string;
  opaque: boolean;
  text: string;
};
type InlineItem = TextItem | { kind: "atom"; node: CanonicalValue };

// Collapse renderer-equivalent whitespace in PROSE to single spaces (tab, CR/LF, NBSP, and repeats all read
// the same), leaving code/opaque text untouched. Code and prose text are both NFC-normalized first.
function normalizeSegmentText(text: string, opaque: boolean): string {
  const normalized = text.normalize("NFC");
  return opaque ? normalized : normalized.replace(/\s+/gu, " ");
}

// Project a block's inline children to a canonical run. Adjacent runs with identical surviving marks are
// merged (so "ab" and "a"+"b", or a bold run beside a plain run, coincide once presentation is dropped),
// prose whitespace is collapsed, the run's outer edges are trimmed, and emptied prose segments drop out — so
// only meaningful inline content, in order, survives.
function canonicalInlineRun(children: DocumentNodeJSON[], opaqueBlock: boolean): CanonicalValue[] {
  const merged: InlineItem[] = [];

  for (const child of children) {
    if (child.type === "text") {
      const marks = canonicalMarks(child.marks);
      const marksKey = JSON.stringify(marks);
      const previous = merged[merged.length - 1];

      // A validated document (parsed + checked) never contains an empty text node, so a text child always
      // carries a string; the assertion keeps that guarantee explicit without an unreachable fallback.
      const text = child.text!;
      if (previous !== undefined && previous.kind === "text" && previous.marksKey === marksKey) {
        previous.text += text;
      } else {
        merged.push({
          kind: "text",
          marks,
          marksKey,
          opaque: opaqueBlock || marksAreCode(marks),
          text
        });
      }
    } else {
      merged.push({ kind: "atom", node: canonicalNode(child) });
    }
  }

  for (const item of merged) {
    if (item.kind === "text") {
      item.text = normalizeSegmentText(item.text, item.opaque);
    }
  }

  // Trim only the run's outer prose whitespace: a leading/trailing space is renderer-equivalent to none, but
  // a space BETWEEN two segments (around an inline atom or a code run) is a real word boundary and stays.
  const prose = merged.filter((item): item is TextItem => item.kind === "text" && !item.opaque);
  const first = prose[0];
  if (first !== undefined) {
    // A non-empty prose list always has a last item too, so the index is safe without a second branch.
    const last = prose[prose.length - 1]!;
    first.text = first.text.replace(/^ /u, "");
    last.text = last.text.replace(/ $/u, "");
  }

  return merged
    .filter((item) => item.kind === "atom" || item.opaque || item.text !== "")
    .map(
      (item): CanonicalValue => (item.kind === "atom" ? item.node : ["t", item.marks, item.text])
    );
}

// Project one node: its type, canonical attributes, and either its inline run (inline-content nodes) or its
// recursively-projected block children. Node type and order are always preserved, so structure is material.
function canonicalNode(node: DocumentNodeJSON): CanonicalValue {
  const attrs = canonicalAttributes(node.attrs);
  const content: CanonicalValue = INLINE_CONTENT_NODE_TYPES.has(node.type)
    ? canonicalInlineRun(node.content ?? [], OPAQUE_TEXT_NODE_TYPES.has(node.type))
    : (node.content ?? []).map(canonicalNode);

  return ["n", node.type, attrs, content];
}

// Whether the document holds a semantic atom (image, raw-HTML unknown, or footnote marker) anywhere, so a
// text-empty document that still carries one is not treated as blank.
function hasSemanticAtom(node: DocumentNodeJSON): boolean {
  return SEMANTIC_ATOM_NODE_TYPES.has(node.type) || (node.content ?? []).some(hasSemanticAtom);
}

// Project a validated Note document to its canonical semantic identity string.
//
// The document is validated FIRST (an unknown node, a broken content shape, or an unsafe link href fails as
// a `DocumentValidationError` before any projection), then a body-bearing document that carries no material
// is rejected as a `BlankNoteMaterialError` — both fail loudly before a fingerprint is ever derived. The
// returned string is deterministic, idempotent, and independent of generated ids, attribute key order, and
// renderer-equivalent whitespace/emphasis, while preserving case, punctuation, symbols, digits, script,
// links/destinations, inline code, code language/content, structure, images, footnotes, and unknown HTML.
export function projectNoteMaterial(json: unknown): string {
  const serialized = serializeDocument(parseDocument(json));

  if (documentText(serialized).trim() === "" && !hasSemanticAtom(serialized)) {
    throw new BlankNoteMaterialError();
  }

  return JSON.stringify(canonicalNode(serialized));
}
