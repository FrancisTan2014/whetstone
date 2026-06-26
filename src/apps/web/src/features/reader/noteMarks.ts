import type { Element, ElementContent, Root, RootContent, Text } from "hast";

// A delicate underline mark to draw over one note's anchored character range. Ranges are
// half-open `[startOffset, endOffset)` against the block's plaintext (the same offsets the note
// anchor stores) and — by the disjoint-annotation invariant (#163) — never overlap. `className`
// is the template-hue class (e.g. "noteMark--vocab"); `noteId` and `ariaLabel` make the rendered
// span an accessible, identifiable tap/keyboard target.
export type NoteMark = Readonly<{
  ariaLabel: string;
  className: string;
  endOffset: number;
  noteId: string;
  startOffset: number;
}>;

// Block containers whose direct whitespace-only text children are *structural* whitespace inserted
// by mdast-util-to-hast (newlines between list items, table rows, blockquote paragraphs). Those
// characters are absent from the block's plaintext (`mdast-util-to-string`), so they must not
// advance the offset cursor. Text inside phrasing elements (p, headings, em/strong/a/code, td/th)
// is real content — including inter-word spaces and soft-break newlines — and is always counted.
const blockContainerTags = new Set([
  "blockquote",
  "li",
  "ol",
  "table",
  "tbody",
  "thead",
  "tr",
  "ul"
]);

function isWhitespaceOnly(value: string): boolean {
  return value.trim().length === 0;
}

function textNode(value: string): Text {
  return { type: "text", value };
}

// Wrap a marked text segment in the note's underline span. hast property casing is normalized by
// hast-util-to-jsx-runtime to real DOM attributes: `className` array -> class, `tabIndex` ->
// tabindex, `ariaLabel` -> aria-label, `dataNoteId` -> data-note-id. The span is phrasing content,
// so it nests validly inside any inline context (paragraph, list item, table cell, link).
function markSpan(value: string, mark: NoteMark): Element {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: ["noteMark", mark.className],
      role: "button",
      tabIndex: 0,
      ariaLabel: mark.ariaLabel,
      dataNoteId: mark.noteId
    },
    children: [textNode(value)]
  };
}

// Split one content text node (covering plaintext range `[nodeStart, nodeStart + value.length)`)
// into before/marked/after pieces for every mark that intersects it. Marks are pre-sorted and
// disjoint, so the pieces come out in document order. A mark spanning inline formatting or several
// text nodes simply contributes a span to each node it touches, forming one continuous underline.
function splitTextByMarks(
  value: string,
  nodeStart: number,
  marks: ReadonlyArray<NoteMark>
): ElementContent[] {
  const nodeEnd = nodeStart + value.length;
  const pieces: ElementContent[] = [];
  let consumed = 0;

  for (const mark of marks) {
    if (mark.endOffset <= nodeStart || mark.startOffset >= nodeEnd) {
      continue;
    }

    const localStart = Math.max(mark.startOffset, nodeStart) - nodeStart;
    const localEnd = Math.min(mark.endOffset, nodeEnd) - nodeStart;

    if (localStart > consumed) {
      pieces.push(textNode(value.slice(consumed, localStart)));
    }

    pieces.push(markSpan(value.slice(localStart, localEnd), mark));
    consumed = localEnd;
  }

  if (pieces.length === 0) {
    return [textNode(value)];
  }

  if (consumed < value.length) {
    pieces.push(textNode(value.slice(consumed)));
  }

  return pieces;
}

type Cursor = { offset: number };

function transformChildren(
  children: ElementContent[],
  parentTag: string | undefined,
  marks: ReadonlyArray<NoteMark>,
  cursor: Cursor
): ElementContent[] {
  const out: ElementContent[] = [];

  for (const child of children) {
    if (child.type === "text") {
      const structural =
        isWhitespaceOnly(child.value) &&
        (parentTag === undefined || blockContainerTags.has(parentTag));

      if (structural) {
        out.push(child);
        continue;
      }

      out.push(...splitTextByMarks(child.value, cursor.offset, marks));
      cursor.offset += child.value.length;
      continue;
    }

    if (child.type === "element") {
      out.push({
        ...child,
        children: transformChildren(child.children, child.tagName, marks, cursor)
      });
      continue;
    }

    out.push(child);
  }

  return out;
}

// Draw the given note marks over a sanitized block hast tree, returning a new tree whose covered
// character ranges are wrapped in underline spans. The offset cursor advances only over content
// text (structural whitespace is skipped — see `blockContainerTags`), so it stays aligned with the
// plaintext offsets the note anchors are stored against. Marks are sorted and assumed disjoint
// (#163's annotation invariant); an empty marks list returns the tree untouched.
export function applyNoteMarks(root: Root, marks: ReadonlyArray<NoteMark>): Root {
  if (marks.length === 0) {
    return root;
  }

  const sorted = [...marks].sort((a, b) => a.startOffset - b.startOffset);
  const cursor: Cursor = { offset: 0 };

  return {
    ...root,
    children: transformChildren(
      root.children as ElementContent[],
      undefined,
      sorted,
      cursor
    ) as RootContent[]
  };
}
