// v0 block types mirror the Markdown constructs the reader anchors notes to and
// search returns. A block is one top-level Markdown node decomposed from a source.
// A `figure` block is an image with an optional caption; its renderable mdast/plaintext
// is the caption (empty when the figure is image-only).
export const blockTypes = ["paragraph", "heading", "list", "blockquote", "code", "figure"] as const;

export type BlockType = (typeof blockTypes)[number];
