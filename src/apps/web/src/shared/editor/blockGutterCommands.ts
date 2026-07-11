import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { runBlockCommandById } from "./blockCommands.js";

// The block-gutter action catalog. Every gutter/menu interaction (#590) moves, duplicates, inserts,
// deletes, or turns a single top-level block through these functions instead of issuing raw Tiptap
// transactions per surface, so id preservation, single-step undo, and the onChange/autosave path stay
// uniform. Each function takes the addressable top-level block by its document position (the value
// Tiptap's drag-handle reports via `onNodeChange`) and runs as one undoable edit; "Turn into" reuses
// the shared block-command catalog (#588) so wrapping transforms keep their stable-id behavior.

// The top-level block (a direct child of `doc`) whose range covers `pos`, with its index among the
// doc's children. `pos` is a position at or inside a top-level block; resolving it and walking to
// depth 1 yields the addressable block regardless of nesting (a selection inside a list item still
// resolves to the wrapping list). Returns null only for an out-of-range position.
interface TopLevelBlock {
  readonly node: ProseMirrorNode;
  readonly index: number;
  readonly start: number;
  readonly end: number;
}

// Resolve the addressable top-level block (a direct child of `doc`) whose range covers `pos`, from a
// ProseMirror document node. Exported so editor-only surfaces that hold a document but no Editor — the
// gutter wash decoration (#590) — resolve the same block range the commands act on, keeping targeting
// identical across the gutter's menu and its highlight.
export function resolveTopLevelBlock(doc: ProseMirrorNode, pos: number): TopLevelBlock | null {
  if (pos < 0 || pos > doc.content.size) {
    return null;
  }

  const $pos = doc.resolve(Math.min(pos, doc.content.size));

  if ($pos.depth === 0) {
    // A boundary position between top-level blocks: the block after it is the target (the drag handle
    // reports the position just before a block).
    const index = $pos.index(0);
    const node = doc.maybeChild(index);

    if (node === null || node === undefined) {
      return null;
    }

    const start = $pos.posAtIndex(index, 0);
    return { end: start + node.nodeSize, index, node, start };
  }

  const node = $pos.node(1);
  const start = $pos.before(1);
  return { end: start + node.nodeSize, index: $pos.index(0), node, start };
}

function topLevelBlockAt(editor: Editor, pos: number): TopLevelBlock | null {
  return resolveTopLevelBlock(editor.state.doc, pos);
}

// Deep JSON clone with every `id` attribute removed, so an inserted or duplicated subtree carries no
// existing id and Tiptap UniqueID stamps a fresh one onto each node. Never mutates the source.
function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripIds(item));
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => {
      if (key === "attrs" && item !== null && typeof item === "object") {
        const { id: _dropped, ...rest } = item as Record<string, unknown>;
        return [[key, rest] as const];
      }

      return [[key, stripIds(item)] as const];
    });

    return Object.fromEntries(entries);
  }

  return value;
}

/** The addressable top-level block index containing `pos`, or null when `pos` is out of range. */
export function blockIndexAt(editor: Editor, pos: number): number | null {
  return topLevelBlockAt(editor, pos)?.index ?? null;
}

/** True when the block at `pos` has a previous sibling it can swap with. */
export function canMoveBlockUp(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);
  return block !== null && block.index > 0;
}

/** True when the block at `pos` has a next sibling it can swap with. */
export function canMoveBlockDown(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);
  return block !== null && block.index < editor.state.doc.childCount - 1;
}

/** True when the block at `pos` is prose that a "Turn into" transform can restyle (not a code block). */
export function canTurnBlockInto(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);

  if (block === null) {
    return false;
  }

  return block.node.type.name !== "codeBlock";
}

// Insert an empty paragraph immediately above or below the block and place the caret in it. UniqueID
// assigns the new paragraph a fresh id; the edit is one undo step and emits onChange like any edit.
function insertParagraph(editor: Editor, pos: number, side: "above" | "below"): boolean {
  const block = topLevelBlockAt(editor, pos);

  if (block === null) {
    return false;
  }

  const at = side === "above" ? block.start : block.end;
  return editor.chain().focus().insertContentAt(at, { type: "paragraph" }).run();
}

/** Insert an empty paragraph above the block at `pos`. */
export function insertBlockAbove(editor: Editor, pos: number): boolean {
  return insertParagraph(editor, pos, "above");
}

/** Insert an empty paragraph below the block at `pos`. */
export function insertBlockBelow(editor: Editor, pos: number): boolean {
  return insertParagraph(editor, pos, "below");
}

/**
 * Duplicate the block at `pos` immediately below it. The copy's whole subtree is stripped of ids so
 * UniqueID assigns fresh ones — it never reuses the source's ids. One undo step.
 */
export function duplicateBlock(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);

  if (block === null) {
    return false;
  }

  const clone = stripIds(block.node.toJSON());
  return editor
    .chain()
    .focus()
    .insertContentAt(block.end, clone as Parameters<Editor["commands"]["insertContentAt"]>[1])
    .run();
}

// Move the block at `pos` past one sibling in a single transaction, preserving every node id (a move
// is delete + re-insert of the same node, so the id round-trips). Returns false at the boundary.
function moveBlock(editor: Editor, pos: number, direction: "up" | "down"): boolean {
  const block = topLevelBlockAt(editor, pos);

  if (block === null) {
    return false;
  }

  const { doc } = editor.state;

  if (direction === "up") {
    if (block.index === 0) {
      return false;
    }

    const previous = doc.child(block.index - 1);
    const previousStart = block.start - previous.nodeSize;

    return editor
      .chain()
      .focus()
      .command(({ tr }) => {
        tr.delete(block.start, block.end);
        tr.insert(previousStart, block.node);

        return true;
      })
      .run();
  }

  if (block.index >= doc.childCount - 1) {
    return false;
  }

  const next = doc.child(block.index + 1);

  return editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.delete(block.start, block.end);
      // After the delete the next sibling shifts to `block.start`; insert past it to swap.
      tr.insert(block.start + next.nodeSize, block.node);

      return true;
    })
    .run();
}

/** Move the block at `pos` above its previous sibling, preserving all ids. */
export function moveBlockUp(editor: Editor, pos: number): boolean {
  return moveBlock(editor, pos, "up");
}

/** Move the block at `pos` below its next sibling, preserving all ids. */
export function moveBlockDown(editor: Editor, pos: number): boolean {
  return moveBlock(editor, pos, "down");
}

/**
 * Delete the block at `pos`. Deleting the only remaining block leaves one empty paragraph rather than
 * an invalid empty document. One undo step.
 */
export function deleteBlock(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);

  if (block === null) {
    return false;
  }

  if (editor.state.doc.childCount === 1) {
    return editor
      .chain()
      .focus()
      .command(({ commands }) => commands.setContent({ type: "doc" }))
      .run();
  }

  return editor.chain().focus().deleteRange({ from: block.start, to: block.end }).run();
}

/**
 * Turn the block at `pos` into another block type from the shared catalog (#588). Places the selection
 * inside the target block first so the catalog command — which reads the current selection and keeps
 * the stable id across wrapping transforms — applies to that block. Returns false for an unknown
 * command id or a block that cannot be transformed (a code block).
 */
export function turnBlockInto(editor: Editor, pos: number, commandId: string): boolean {
  const block = topLevelBlockAt(editor, pos);

  if (block === null || !canTurnBlockInto(editor, pos)) {
    return false;
  }

  editor.commands.setTextSelection(block.start + 1);
  return runBlockCommandById(editor, commandId);
}
