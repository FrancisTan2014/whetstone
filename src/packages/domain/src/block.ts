// v0 block types mirror the Markdown constructs the reader anchors notes to and
// search returns. A block is one top-level Markdown node decomposed from a source.
export const blockTypes = ["paragraph", "heading", "list", "blockquote", "code"] as const;

export type BlockType = (typeof blockTypes)[number];
