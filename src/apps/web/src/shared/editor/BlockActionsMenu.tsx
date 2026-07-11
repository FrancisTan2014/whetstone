import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Editor } from "@tiptap/core";
import type { ReactNode } from "react";

import { blockCommands } from "./blockCommands.js";
import { blockActionsMenuClassNames as cx } from "./BlockActionsMenu.tokens.js";
import {
  canMoveBlockDown,
  canMoveBlockUp,
  canTurnBlockInto,
  deleteBlock,
  duplicateBlock,
  insertBlockAbove,
  insertBlockBelow,
  moveBlockDown,
  moveBlockUp,
  turnBlockInto
} from "./blockGutterCommands.js";

// The explanation shown on the disabled "Turn into" control: a code block types every character
// verbatim, so restyling it to another block type is meaningless (mirrors the slash catalog's own
// code-block exclusion, #588).
const TURN_INTO_DISABLED_HINT = "A code block keeps its type.";

export interface BlockActionsMenuProps {
  readonly editor: Editor;
  /** Document position of the addressable top-level block this menu acts on. */
  readonly pos: number;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The gutter grip or compact "More block actions" button, anchored as the menu trigger. */
  readonly trigger: ReactNode;
}

// The block-actions menu opened from the gutter grip (or the compact/touch trigger). It exposes real
// menu semantics through Radix (role=menu/menuitem, Arrow/Enter/Space/Escape, visible focus, typeahead)
// and every item runs one of the pure block-gutter commands (#590) against the addressable block at
// `pos`. "Turn into" reuses the shared block-command catalog (#588); it is present but disabled on a
// code block with a short explanation. Move up/down disable at the document boundaries. Selecting any
// action — or dismissing with Escape — returns focus to the editor rather than the trigger, so the
// learner lands back in the block they were editing (the caret each command leaves stays put).
export function BlockActionsMenu({
  editor,
  pos,
  open,
  onOpenChange,
  trigger
}: BlockActionsMenuProps): React.JSX.Element {
  const run = (action: (editor: Editor, pos: number) => boolean): void => {
    // Defer past Radix's own close/focus handling for this selection: the command focuses the editor
    // and the menu is closing in the same event, and running inside that churn can race the editor
    // view. A microtask lets the menu settle, then the action applies as one undo step and leaves the
    // caret in the block — where focus restoration (below) keeps it.
    queueMicrotask(() => {
      // Defensive: the surface can only unmount (destroying the editor) between queueing and running
      // this microtask if it is torn down mid-action, which the tests' synchronous flush cannot
      // reproduce; the guard prevents dispatching into a destroyed view.
      /* v8 ignore next 3 */
      if (editor.isDestroyed) {
        return;
      }

      action(editor, pos);
    });
  };

  const canTurn = canTurnBlockInto(editor, pos);
  const canUp = canMoveBlockUp(editor, pos);
  const canDown = canMoveBlockDown(editor, pos);

  return (
    <DropdownMenu.Root modal={false} onOpenChange={onOpenChange} open={open}>
      <DropdownMenu.Trigger asChild>{trigger}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          aria-label="Block actions"
          className={cx.content}
          onCloseAutoFocus={(event) => {
            // Keep the caret the command left in the document instead of letting Radix pull focus
            // back to the (often hover-only) trigger. Deferred so it runs after Radix settles the
            // close, when the editor view is reliably available.
            event.preventDefault();
            queueMicrotask(() => {
              if (!editor.isDestroyed) {
                editor.commands.focus();
              }
            });
          }}
          side="bottom"
          sideOffset={4}
        >
          {canTurn ? (
            <DropdownMenu.Sub>
              <DropdownMenu.SubTrigger className={cx.subTrigger}>
                Turn into
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  aria-label="Turn into"
                  className={cx.subContent}
                  sideOffset={4}
                >
                  {blockCommands.map((command) => (
                    <DropdownMenu.Item
                      className={cx.item}
                      key={command.id}
                      onSelect={() => run((e, p) => turnBlockInto(e, p, command.id))}
                    >
                      {command.label}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ) : (
            <DropdownMenu.Item className={cx.subTrigger} disabled>
              Turn into
              <span className={cx.hint}> ({TURN_INTO_DISABLED_HINT})</span>
            </DropdownMenu.Item>
          )}

          <DropdownMenu.Separator className={cx.separator} />

          <DropdownMenu.Item className={cx.item} onSelect={() => run(insertBlockAbove)}>
            Insert above
          </DropdownMenu.Item>
          <DropdownMenu.Item className={cx.item} onSelect={() => run(insertBlockBelow)}>
            Insert below
          </DropdownMenu.Item>
          <DropdownMenu.Item className={cx.item} onSelect={() => run(duplicateBlock)}>
            Duplicate
          </DropdownMenu.Item>

          <DropdownMenu.Separator className={cx.separator} />

          <DropdownMenu.Item
            className={cx.item}
            disabled={!canUp}
            onSelect={() => run(moveBlockUp)}
          >
            Move up
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={cx.item}
            disabled={!canDown}
            onSelect={() => run(moveBlockDown)}
          >
            Move down
          </DropdownMenu.Item>

          <DropdownMenu.Separator className={cx.separator} />

          <DropdownMenu.Item className={cx.destructiveItem} onSelect={() => run(deleteBlock)}>
            Delete
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
