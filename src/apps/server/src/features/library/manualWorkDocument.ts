import { documentText, type DocumentNodeJSON } from "@whetstone/document";

// The default level a coerced section heading takes: the learner removed the heading, so its intended
// level is unknown; level 1 matches the level a freshly seeded section starts at.
const DEFAULT_SECTION_HEADING_LEVEL = 1;

// The persistence-normalization rule for a manual Work's canonical document (#720). #696's reconciler
// stores whatever top-level nodes it is given, so this pure step enforces the two shape guarantees the
// manual save owns before reconciliation: a saved document always keeps at least one paragraph block, and
// redundant *trailing* empty paragraphs (the blank lines an editor leaves at the end) are trimmed —
// while a deliberate empty paragraph BETWEEN content blocks is preserved as authored spacing. Pure and
// DOM-free, so it is unit-tested without the editor or the database.

// An empty paragraph is a `paragraph` node with no rendered text — the blank line an editor emits. Its
// content may be absent or an empty inline run; either way `documentText` projects to "".
function isEmptyParagraph(node: DocumentNodeJSON): boolean {
  return node.type === "paragraph" && documentText(node) === "";
}

const emptyParagraph: DocumentNodeJSON = { type: "paragraph" };

export function normalizeManualWorkDocument(document: DocumentNodeJSON): DocumentNodeJSON {
  const content = document.content ?? [];

  // Drop only the run of empty paragraphs at the very end; an empty paragraph followed by any later
  // block is interior spacing the author placed on purpose and is kept.
  let end = content.length;
  while (end > 0 && isEmptyParagraph(content[end - 1] as DocumentNodeJSON)) {
    end -= 1;
  }

  const trimmed = content.slice(0, end);

  // Never persist a zero-block document: an all-empty (or emptied) document collapses to one empty
  // paragraph, the same shape a freshly created manual Work starts from.
  return {
    content: trimmed.length === 0 ? [emptyParagraph] : trimmed,
    type: "doc"
  };
}

// A non-leading manual section must stay HEADING-LED (#697). Its first block is the section's outline
// node: both the editor's live Outline and the Reader's TOC derive that section's `level`+`title` from
// it via `documentBlockHeading`. The shared editor toolbar can turn that first block into a
// paragraph/list/quote/code, and the save path accepts any valid document, so a learner could otherwise
// save a mid-work section whose first block is no longer a heading. `buildHeadingOutline` then treats
// that headingless unit as a root "Start" entry — but "Start" is only ever the leading pre-heading
// section, so a mid-work "Start" would appear in BOTH the Outline and the Reader. This pure step
// re-establishes the invariant on save by coercing a non-heading first block back into a heading: a
// paragraph is remapped in place (its inline run — text and marks — and block id are preserved, so a
// note anchored to it survives), and any other block seeds a heading from its plaintext. The leading
// section is exempt (its caller does not apply this), because pre-heading content there is a legitimate
// "Start".
function coerceToHeading(block: DocumentNodeJSON): DocumentNodeJSON {
  // A paragraph carries the same inline content model a heading does, so flipping its type is a lossless
  // remap of the common "changed the title to a Paragraph" case — id, text, and marks all survive.
  if (block.type === "paragraph") {
    return {
      ...block,
      attrs: { ...block.attrs, level: DEFAULT_SECTION_HEADING_LEVEL },
      type: "heading"
    };
  }

  // Any other block (list, quote, code, rule, …) holds block-level or no inline children, so it cannot
  // become a heading in place; the heading is seeded from the block's plaintext instead, and an empty
  // block yields an untitled heading.
  const text = documentText(block);
  return {
    attrs: { level: DEFAULT_SECTION_HEADING_LEVEL },
    type: "heading",
    ...(text === "" ? {} : { content: [{ text, type: "text" }] })
  };
}

export function ensureHeadingLedSection(document: DocumentNodeJSON): DocumentNodeJSON {
  const content = document.content ?? [];
  const [first, ...rest] = content;

  // An empty document (no blocks) or one already led by a heading needs no change. `normalizeManual-
  // WorkDocument` guarantees at least one block before this runs, but the empty guard keeps the pure
  // function total and independently testable.
  if (first === undefined || first.type === "heading") {
    return document;
  }

  return { content: [coerceToHeading(first), ...rest], type: "doc" };
}
