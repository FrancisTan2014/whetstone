import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";

import { Button } from "../ui/Button.js";
import { BlockActionsMenu } from "./BlockActionsMenu.js";
import { blockActionsMenuClassNames } from "./BlockActionsMenu.tokens.js";
import { editorClassNames } from "./RichContentEditor.tokens.js";

// The vertical grip icon shown in the gutter (16px), centered in its 44px target by the button.
function GripIcon(): React.JSX.Element {
  return (
    <svg aria-hidden="true" fill="currentColor" height="16" viewBox="0 0 16 16" width="16">
      <circle cx="6" cy="4" r="1.4" />
      <circle cx="10" cy="4" r="1.4" />
      <circle cx="6" cy="8" r="1.4" />
      <circle cx="10" cy="8" r="1.4" />
      <circle cx="6" cy="12" r="1.4" />
      <circle cx="10" cy="12" r="1.4" />
    </svg>
  );
}

export interface BlockGutterHandleProps {
  readonly editor: Editor;
  /** The top-level block position the pointer is currently over, or null when the gutter is idle. */
  readonly gutterPos: number | null;
  readonly onGutterPosChange: (pos: number | null) => void;
  readonly open: boolean;
  readonly onMenuChange: (menu: { readonly pos: number; readonly source: "gutter" } | null) => void;
}

// The pointer contextual gutter (#590): Tiptap's official drag handle reveals a single grip beside the
// top-level block under a fine, hovering pointer. The grip drags the whole block (its entire subtree —
// list, blockquote, figure, or table — as one unit) to reorder, and opens the block-actions menu. This
// is a pointer-only affordance: the drag handle renders `children` into its own hidden, detached
// portal that only becomes interactive under a real pointer, so its reveal (onNodeChange), drag, drop
// indicator, and grip-triggered menu are exercised by the Playwright gutter e2e — this module is
// excluded from coverage in vitest.config.ts. Every block action it invokes is the same pure command
// unit-tested through the always-available "More block actions" trigger and Shift+F10.
export function BlockGutterHandle({
  editor,
  gutterPos,
  onGutterPosChange,
  open,
  onMenuChange
}: BlockGutterHandleProps): React.JSX.Element {
  return (
    <DragHandle
      className={editorClassNames.gutter}
      editor={editor}
      onNodeChange={({ node, pos }) => onGutterPosChange(node === null ? null : pos)}
    >
      <BlockActionsMenu
        editor={editor}
        onOpenChange={(next) =>
          onMenuChange(next && gutterPos !== null ? { pos: gutterPos, source: "gutter" } : null)
        }
        open={open}
        pos={gutterPos ?? 0}
        trigger={
          <Button
            aria-label="Block actions"
            className={blockActionsMenuClassNames.grip}
            size="sm"
            variant="ghost"
          >
            <GripIcon />
          </Button>
        }
      />
    </DragHandle>
  );
}
