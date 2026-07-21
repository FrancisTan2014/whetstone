import { documentText, type DocumentNodeJSON } from "@whetstone/document";

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
