import { Extension } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { resolveTopLevelBlock } from "./blockGutterCommands.js";
import { blockGutterHighlightClass } from "./blockGutterHighlight.tokens.js";

// The transient block wash (#590). A pure decoration extension: it holds one target position (the
// value the drag handle reports, i.e. just before a top-level block) and paints a node decoration —
// carrying the `--color-surface` wash class — over exactly that block. It never edits the document,
// so it costs nothing at rest, moves no text, and leaves the reader untouched (the reader mounts the
// shared document extensions without this editing-only one). The web surface sets and clears the
// target as the handle is hovered, focused, dragged, or its menu locked open.
interface HighlightState {
  readonly target: number | null;
}

export const blockGutterHighlightKey = new PluginKey<HighlightState>("blockGutterHighlight");

// Meta payload dispatched to move or clear the wash: `{ target: pos }` to wash the block at `pos`,
// `{ target: null }` to clear it.
interface HighlightMeta {
  readonly target: number | null;
}

function readMeta(value: unknown): HighlightMeta | undefined {
  if (value !== null && typeof value === "object" && "target" in value) {
    const { target } = value as { target: unknown };
    if (target === null || typeof target === "number") {
      return { target };
    }
  }

  return undefined;
}

export const BlockGutterHighlight = Extension.create({
  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: blockGutterHighlightKey,
        props: {
          decorations: (state) => {
            // state.init always seeds { target: null }, so getState is defined whenever decorations
            // runs; the fallback only guards a getState-before-init that ProseMirror never triggers.
            /* v8 ignore next */
            const { target } = blockGutterHighlightKey.getState(state) ?? { target: null };

            if (target === null) {
              return DecorationSet.empty;
            }

            const block = resolveTopLevelBlock(state.doc, target);

            if (block === null) {
              return DecorationSet.empty;
            }

            return DecorationSet.create(state.doc, [
              Decoration.node(block.start, block.end, { class: blockGutterHighlightClass })
            ]);
          }
        },
        state: {
          apply: (tr, current) => {
            const meta = readMeta(tr.getMeta(blockGutterHighlightKey));

            if (meta !== undefined) {
              return { target: meta.target };
            }

            // Keep the wash on the same block across ordinary edits by mapping its position forward;
            // a deleted target maps to null and clears.
            if (current.target === null) {
              return current;
            }

            const mapped = tr.mapping.mapResult(current.target);
            return { target: mapped.deleted ? null : mapped.pos };
          },
          init: () => ({ target: null })
        }
      })
    ];
  },
  name: "blockGutterHighlight"
});

// Wash the top-level block at `pos`, or clear the wash when `pos` is null. A no-op transaction that
// only carries plugin meta, so it never enters the undo history or emits a document change.
export function setBlockGutterTarget(editor: Editor, pos: number | null): void {
  const { tr } = editor.state;
  editor.view.dispatch(tr.setMeta(blockGutterHighlightKey, { target: pos }));
}
