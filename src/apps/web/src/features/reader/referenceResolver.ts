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
type ReferenceTarget = Readonly<{
  anchor: string;
  sourceFile?: string;
}>;

// The resolved location of a cross-reference target: the owning `doc_blocks` entry id (fed to the
// reader's block-jump) and the stable PM node id of the exact element the anchor lives on. The node
// id gives element-precise jump within the block; it equals `blockEntryId` when the anchor is the
// block's own top-level id (#550).
export type ResolvedAnchor = Readonly<{
  blockEntryId: string;
  nodeId: string;
}>;

// An opaque, immutable lookup built once per open work. The map is private to this module; consumers
// call `resolve` (jump target), `canResolve` (the inert gate — whether a same-work reference has a
// live target), and `anchorsForBlock` (the block's id-bearing elements, for element-precise render
// stamping).
export type AnchorIndex = Readonly<{
  resolve: (target: ReferenceTarget) => ResolvedAnchor | undefined;
  canResolve: (target: ReferenceTarget) => boolean;
  anchorsForBlock: (blockEntryId: string) => ReadonlyArray<BlockAnchor>;
}>;

// One id-bearing element inside a block: the source-HTML `anchor` and the stable PM `nodeId` that
// carries it, so the reader can stamp `data-anchor-id` onto the precise nested element (#550).
export type BlockAnchor = Readonly<{
  anchor: string;
  nodeId: string;
}>;

// A NUL separator can never appear in a source path or an HTML id, so it composes the two-part key
// without ambiguity (e.g. `("a", "b#c")` and `("a#b", "c")` stay distinct).
function anchorKey(sourceFile: string | null | undefined, anchor: string): string {
  return `${sourceFile ?? ""}\u0000${anchor}`;
}

// Build the work-scoped resolver from the fetched index. Later index entries for the same
// (sourceFile, anchor) do not overwrite earlier ones, so the first element carrying an anchor wins —
// matching the reader's top-to-bottom reading order. A per-block list is also accumulated (in index
// order) so the reader can stamp each id-bearing element with its source anchor at render time.
export function buildAnchorIndex(dto: WorkAnchorIndexDto): AnchorIndex {
  const byKey = new Map<string, ResolvedAnchor>();
  const byBlock = new Map<string, BlockAnchor[]>();

  for (const entry of dto.anchors) {
    const key = anchorKey(entry.sourceFile, entry.anchor);

    if (!byKey.has(key)) {
      byKey.set(key, { blockEntryId: entry.blockEntryId, nodeId: entry.nodeId });
    }

    const blockAnchors = byBlock.get(entry.blockEntryId);
    const blockAnchor: BlockAnchor = { anchor: entry.anchor, nodeId: entry.nodeId };

    if (blockAnchors === undefined) {
      byBlock.set(entry.blockEntryId, [blockAnchor]);
    } else {
      blockAnchors.push(blockAnchor);
    }
  }

  return {
    resolve: (target) => byKey.get(anchorKey(target.sourceFile, target.anchor)),
    canResolve: (target) => byKey.has(anchorKey(target.sourceFile, target.anchor)),
    anchorsForBlock: (blockEntryId) => byBlock.get(blockEntryId) ?? []
  };
}
