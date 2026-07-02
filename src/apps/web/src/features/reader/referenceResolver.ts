import type { WorkAnchorIndexDto } from "@whetstone/contracts";

// A work-scoped reference resolver built from the work's anchor index (#366). A cross-reference in
// the reader — a footnote/endnote marker, and later (#368) an inline link — names a target by its
// source file and the source-HTML id (anchor) it points at; resolving that pair yields the block
// entry id the reader jumps to via `jumpToBlock`. Keying on (sourceFile, anchor) is what keeps the
// same anchor id reused across two source files from colliding: each file's copy resolves to its own
// block.

// The target of a cross-reference: the anchor (source-HTML id) it points at, plus the source file
// that anchor lives in. `sourceFile` is undefined for a same-file reference whose owning unit has no
// recorded source file (the Markdown/PDF path), which the index stores as an empty-string key.
export type ReferenceTarget = Readonly<{
  anchor: string;
  sourceFile?: string;
}>;

// An opaque, immutable lookup built once per open work. The map is private to this module; consumers
// only ever call `resolve`.
export type AnchorIndex = Readonly<{
  resolve: (target: ReferenceTarget) => string | undefined;
}>;

// A NUL separator can never appear in a source path or an HTML id, so it composes the two-part key
// without ambiguity (e.g. `("a", "b#c")` and `("a#b", "c")` stay distinct).
function anchorKey(sourceFile: string | null | undefined, anchor: string): string {
  return `${sourceFile ?? ""}\u0000${anchor}`;
}

// Build the work-scoped resolver from the fetched index. Later index entries for the same
// (sourceFile, anchor) do not overwrite earlier ones, so the first block carrying an anchor wins —
// matching the reader's top-to-bottom reading order.
export function buildAnchorIndex(dto: WorkAnchorIndexDto): AnchorIndex {
  const byKey = new Map<string, string>();

  for (const entry of dto.anchors) {
    const key = anchorKey(entry.sourceFile, entry.anchor);

    if (!byKey.has(key)) {
      byKey.set(key, entry.blockEntryId);
    }
  }

  return {
    resolve: (target) => byKey.get(anchorKey(target.sourceFile, target.anchor))
  };
}
