import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { Editor } from "@tiptap/core";
import { Bold, ChevronDown, Code, Italic, List, ListOrdered, Redo2, Undo2 } from "lucide-react";
import { useState } from "react";

import { Button, IconButton } from "../ui/Button.js";
import { runBlockCommandById } from "./blockCommands.js";
import { blockStyleOptions, currentBlockStyle } from "./blockStyleMenu.js";
import { editorToolbarClassNames as cx } from "./EditorToolbar.tokens.js";

// The Work editor's persistent formatting toolbar (#720, #791). Unlike the authored surface's
// selection-only bubble menu, the Work editor keeps formatting on screen so an administrator curating a
// passage can format without discovering the contextual menus. It presents as ONE sticky row attached to
// the editor surface: a current-style menu (Text / Heading 1-3 / Quote / Code block) followed by inline
// marks, list wraps, and history — every control a >=44px target. The row never wraps or shrinks; below the
// available width it scrolls horizontally and the focused control scrolls into view. Each control is a thin
// seam over the SAME editor primitives the other surfaces use — block transforms go through the shared
// `runBlockCommandById` catalog (so stable-id preservation is identical), inline marks and history through
// Tiptap's own commands — never a bespoke transaction. The toolbar owns no editor state: it reflects the
// live editor and mutates only through it.

const iconProps = { "aria-hidden": true, size: 18, strokeWidth: 1.75 } as const;

// An inline-mark control toggles a mark on the selection and lights up when the mark is active. `mark` is
// the mark name for the live active check; `toggle` runs the mark's own Tiptap command through a focused
// chain so the selection is never lost when the toolbar takes focus.
type MarkControl = Readonly<{
  icon: React.JSX.Element;
  label: string;
  mark: string;
  toggle: (editor: Editor) => boolean;
}>;

const markControls: readonly MarkControl[] = [
  {
    icon: <Bold {...iconProps} />,
    label: "Bold",
    mark: "bold",
    toggle: (editor) => editor.chain().focus().toggleMark("bold").run()
  },
  {
    icon: <Italic {...iconProps} />,
    label: "Italic",
    mark: "italic",
    toggle: (editor) => editor.chain().focus().toggleMark("italic").run()
  },
  {
    icon: <Code {...iconProps} />,
    label: "Inline code",
    mark: "code",
    toggle: (editor) => editor.chain().focus().toggleMark("code").run()
  }
];

// The two list wraps kept as their own controls (Quote and Code block moved into the style menu, #791).
type ListControl = Readonly<{
  icon: React.JSX.Element;
  id: string;
  isActive: (editor: Editor) => boolean;
  label: string;
}>;

const listControls: readonly ListControl[] = [
  {
    icon: <List {...iconProps} />,
    id: "bullet-list",
    isActive: (editor) => editor.isActive("bulletList"),
    label: "Bulleted list"
  },
  {
    icon: <ListOrdered {...iconProps} />,
    id: "ordered-list",
    isActive: (editor) => editor.isActive("orderedList"),
    label: "Numbered list"
  }
];

// The live toolbar controls, in DOM order, for the single-tab-stop arrow navigation (ARIA toolbar pattern).
// Read from the DOM so the roving logic stays correct no matter how many controls render.
function focusableItems(toolbar: HTMLElement): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>("[data-toolbar-item]"));
}

export function EditorToolbar({ editor }: Readonly<{ editor: Editor }>): React.JSX.Element {
  // The one control that is in the tab order (roving tabindex); every other control is reachable only by the
  // toolbar's own arrow navigation, so the whole toolbar is a single Tab stop.
  const [activeIndex, setActiveIndex] = useState(0);

  const style = currentBlockStyle(editor);

  const itemProps = (
    index: number
  ): Readonly<{
    "data-toolbar-item": true;
    onFocus: (event: React.FocusEvent<HTMLElement>) => void;
    tabIndex: number;
  }> => ({
    "data-toolbar-item": true,
    onFocus: (event) => {
      setActiveIndex(index);
      // Keep the focused control visible when the row has scrolled horizontally.
      event.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
    },
    tabIndex: index === activeIndex ? 0 : -1
  });

  // Left/Right move focus between controls, Home/End jump to the ends, wrapping at the edges. Ignored while
  // focus is inside an open menu (its content is portaled outside the toolbar, so `document.activeElement`
  // is not a toolbar control), where Radix owns arrow/Escape behavior.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowLeft", "ArrowRight", "End", "Home"].includes(event.key)) {
      return;
    }
    const items = focusableItems(event.currentTarget);
    const current = items.findIndex((item) => item === document.activeElement);
    if (current === -1) {
      return;
    }
    event.preventDefault();
    const last = items.length - 1;
    const next =
      event.key === "ArrowRight"
        ? current === last
          ? 0
          : current + 1
        : event.key === "ArrowLeft"
          ? current === 0
            ? last
            : current - 1
          : event.key === "Home"
            ? 0
            : last;
    items[next]?.focus();
  };

  // Return focus to the editor when the style menu closes (Radix would otherwise pull it back to the
  // trigger), so a chosen command lands the caret back in the document. Deferred past Radix's close churn.
  const focusEditor = (event: Event): void => {
    event.preventDefault();
    queueMicrotask(() => {
      /* v8 ignore next 3 -- the editor can only be destroyed mid-close if the surface unmounts between the
         menu closing and this microtask, which the tests' synchronous flush cannot reproduce. */
      if (editor.isDestroyed) {
        return;
      }
      editor.commands.focus();
    });
  };

  // Keep the editor focused when a formatting control is pressed: without this, the button steals focus on
  // mousedown, and the first press right after the block-style menu closes is swallowed by Radix's dismiss
  // guard before its click handler runs. Preventing the mousedown default keeps the caret and selection in
  // the document so the command applies to the live selection on the very first press.
  const keepEditorFocus = (event: React.MouseEvent<HTMLButtonElement>): void => {
    event.preventDefault();
  };

  let index = 0;

  return (
    <div
      aria-label="Formatting"
      aria-orientation="horizontal"
      className={cx.root}
      onKeyDown={onKeyDown}
      role="toolbar"
    >
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button
            aria-label="Block style"
            className={cx.styleTrigger}
            variant="secondary"
            {...itemProps(index++)}
          >
            <span>{style.label}</span>
            <ChevronDown aria-hidden size={16} strokeWidth={1.75} />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            aria-label="Block style"
            className={cx.menu}
            onCloseAutoFocus={focusEditor}
            side="bottom"
            sideOffset={4}
          >
            {blockStyleOptions.map((option) => (
              <DropdownMenu.Item
                aria-current={option.id === style.id ? "true" : undefined}
                className={cx.menuItem}
                key={option.id}
                onSelect={() => runBlockCommandById(editor, option.id)}
              >
                {option.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {markControls.map((control) => (
        <IconButton
          aria-pressed={editor.isActive(control.mark)}
          className={cx.item}
          icon={control.icon}
          key={control.mark}
          label={control.label}
          onClick={() => control.toggle(editor)}
          onMouseDown={keepEditorFocus}
          variant={editor.isActive(control.mark) ? "secondary" : "ghost"}
          {...itemProps(index++)}
        />
      ))}

      {listControls.map((control) => (
        <IconButton
          aria-pressed={control.isActive(editor)}
          className={cx.item}
          icon={control.icon}
          key={control.id}
          label={control.label}
          onClick={() => runBlockCommandById(editor, control.id)}
          onMouseDown={keepEditorFocus}
          variant={control.isActive(editor) ? "secondary" : "ghost"}
          {...itemProps(index++)}
        />
      ))}

      <IconButton
        aria-disabled={!editor.can().undo()}
        className={cx.item}
        icon={<Undo2 {...iconProps} />}
        label="Undo"
        onClick={() => {
          if (editor.can().undo()) {
            editor.commands.undo();
          }
        }}
        onMouseDown={keepEditorFocus}
        variant="ghost"
        {...itemProps(index++)}
      />
      <IconButton
        aria-disabled={!editor.can().redo()}
        className={cx.item}
        icon={<Redo2 {...iconProps} />}
        label="Redo"
        onClick={() => {
          if (editor.can().redo()) {
            editor.commands.redo();
          }
        }}
        onMouseDown={keepEditorFocus}
        variant="ghost"
        {...itemProps(index++)}
      />
    </div>
  );
}
