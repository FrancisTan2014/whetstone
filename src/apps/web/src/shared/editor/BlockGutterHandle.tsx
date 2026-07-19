import type { Editor } from "@tiptap/core";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import { GripVertical } from "lucide-react";

import { Button } from "../ui/Button.js";
import { BlockActionsMenu } from "./BlockActionsMenu.js";
import { blockActionsMenuClassNames } from "./BlockActionsMenu.tokens.js";
import { editorClassNames } from "./RichContentEditor.tokens.js";

// The vertical grip icon shown in the gutter (16px), centered in its 44px target by the button.
function GripIcon(): React.JSX.Element {
  return <GripVertical aria-hidden height={16} strokeWidth={1.75} width={16} />;
}

export interface BlockGutterHandleProps {
  readonly editor: Editor;
  /** Portals the grip's block-actions menu into the shared floating layer so it stays above a Sheet's
   * overlay (#645); unset, Radix defaults the portal to `document.body` (the standalone behavior). */
  readonly container?: () => HTMLElement;
  /** The top-level block position the pointer is currently over, or null when the gutter is idle. */
  readonly gutterPos: number | null;
  /**
   * The block-actions menu the editor currently has open, if any. Once this grip's menu opens on a
   * block, the grip's live hover (`gutterPos`) may drift to another block or clear as the pointer
   * moves onto the dropdown; the menu must keep acting on — and washing — the block it opened for.
   * The editor paints the wash from this same `openMenu.pos`, so deriving the command target from it
   * keeps the visual wash and the command target identical for as long as the menu is open.
   */
  readonly openMenu: { readonly pos: number; readonly source: "gutter" | "more" } | null;
  readonly onGutterPosChange: (pos: number | null) => void;
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
  container,
  gutterPos,
  openMenu,
  onGutterPosChange,
  onMenuChange
}: BlockGutterHandleProps): React.JSX.Element {
  // While this grip's menu is open it is locked to the block it opened on. The live hover (`gutterPos`)
  // may drift or clear as the pointer moves onto the dropdown, so the command target — and the wash the
  // editor paints from this same position — must follow the lock, not the hover.
  const lockedPos = openMenu?.source === "gutter" ? openMenu.pos : null;
  return (
    <DragHandle
      className={editorClassNames.gutter}
      editor={editor}
      onNodeChange={({ node, pos }) => onGutterPosChange(node === null ? null : pos)}
    >
      <BlockActionsMenu
        {...(container === undefined ? {} : { container })}
        editor={editor}
        onOpenChange={(next) =>
          onMenuChange(next && gutterPos !== null ? { pos: gutterPos, source: "gutter" } : null)
        }
        open={lockedPos !== null}
        pos={lockedPos ?? gutterPos ?? 0}
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
