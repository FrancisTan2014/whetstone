import { Extension } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { exitSuggestion, Suggestion } from "@tiptap/suggestion";

import { blockCommands, type BlockCommand, filterBlockCommands } from "./blockCommands.js";
import {
  SlashCommandMenu,
  type SlashCommandMenuHandle,
  type SlashCommandMenuProps
} from "./SlashCommandMenu.js";
import { isSlashContextAllowed } from "./slashCommandContext.js";

// The keyboard-first slash menu: a thin Tiptap extension that wires the maintained `@tiptap/suggestion`
// utility (trigger detection, caret decoration, managed floating-ui positioning with edge flip, and
// outside-click dismissal via `mount`) to the shared block-command catalog and the React listbox. All
// product logic lives in tested pure modules — the catalog (`blockCommands`), the context gate
// (`isSlashContextAllowed`) — so this file only owns the render lifecycle and key routing.

interface SlashMenuRenderState {
  renderer: ReactRenderer<SlashCommandMenuHandle, SlashCommandMenuProps> | null;
  unmount: (() => void) | null;
}

function menuProps(props: {
  items: BlockCommand[];
  query: string;
  command: (item: BlockCommand) => void;
}): SlashCommandMenuProps {
  return { items: props.items, onSelect: props.command, query: props.query };
}

export const SlashCommand = Extension.create({
  addProseMirrorPlugins() {
    return [
      Suggestion<BlockCommand, BlockCommand>({
        allow: ({ state }) => isSlashContextAllowed(state),
        char: "/",
        // Selecting a command deletes the `/query` and applies the block transform in one chain, so a
        // single undo restores both the slash text and the original block type.
        command: ({ editor, props, range }) => {
          props.appendTo(editor.chain().focus().deleteRange(range)).run();
        },
        editor: this.editor,
        // The suggestion `allow` gate already restricts the menu to a plain textblock (never a code
        // block or an inline-code/link run), and every catalog command is available in exactly that
        // context, so the query filter alone decides the list. Per-command `isAvailable` stays a
        // catalog property for future surfaces whose availability varies (e.g. a block/drag menu).
        items: ({ query }) => [...filterBlockCommands(blockCommands, query)],
        render: () => {
          const state: SlashMenuRenderState = { renderer: null, unmount: null };

          return {
            onExit: () => {
              state.unmount?.();
              state.renderer?.destroy();
              state.unmount = null;
              state.renderer = null;
            },
            onKeyDown: ({ event, view }) => {
              if (event.key === "Escape" || event.key === "Tab") {
                exitSuggestion(view);
                return true;
              }

              // The suggestion utility routes navigation keys here only while the menu is mounted
              // (between onStart and onExit), so the renderer and its imperative handle are always
              // present; the optional chain and `?? false` exist solely to satisfy the nullable
              // ReactRenderer ref type. The Arrow/Enter integration tests exercise the real routing,
              // so the null branches are unreachable and excluded from coverage.
              /* v8 ignore next */
              return state.renderer?.ref?.onKeyDown(event) ?? false;
            },
            onStart: (props) => {
              const renderer = new ReactRenderer<SlashCommandMenuHandle, SlashCommandMenuProps>(
                SlashCommandMenu,
                { editor: props.editor, props: menuProps(props) }
              );

              state.renderer = renderer;
              state.unmount = props.mount(renderer.element as HTMLElement);
            },
            onUpdate: (props) => {
              state.renderer?.updateProps(menuProps(props));
            }
          };
        }
      })
    ];
  },
  name: "slashCommand"
});
