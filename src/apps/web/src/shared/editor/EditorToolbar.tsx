import type { Editor } from "@tiptap/core";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Pilcrow,
  Quote,
  Redo2,
  SquareCode,
  Undo2
} from "lucide-react";

import { IconButton } from "../ui/Button.js";
import { runBlockCommandById } from "./blockCommands.js";
import { editorToolbarClassNames } from "./EditorToolbar.tokens.js";

// The manual-Work editor's persistent formatting toolbar (#720). Unlike the authored surface's
// selection-only bubble menu, the Library editor keeps every block and inline control on screen so a
// learner curating a passage can format without discovering the contextual menus. Each control is a thin
// seam over the SAME editor primitives the other surfaces use — block transforms go through the shared
// `runBlockCommandById` catalog (so stable-id preservation is identical), inline marks and history through
// Tiptap's own commands — never a bespoke transaction. The toolbar owns no state: it reflects the live
// editor (active marks/blocks, whether undo/redo is possible) and mutates only through the editor.

const iconProps = { "aria-hidden": true, size: 18, strokeWidth: 1.75 } as const;

// A block-style control turns the current block into one document block type (paragraph, headings, lists,
// quote, code block) and lights up when the selection already sits in that type, so the toolbar shows the
// current structure at a glance. `isActive` reads the live editor; `id` is the shared block-command id.
type BlockControl = Readonly<{
  icon: React.JSX.Element;
  id: string;
  isActive: (editor: Editor) => boolean;
  label: string;
}>;

const blockControls: readonly BlockControl[] = [
  {
    icon: <Pilcrow {...iconProps} />,
    id: "paragraph",
    isActive: (editor) => editor.isActive("paragraph"),
    label: "Paragraph"
  },
  {
    icon: <Heading1 {...iconProps} />,
    id: "heading-1",
    isActive: (editor) => editor.isActive("heading", { level: 1 }),
    label: "Heading 1"
  },
  {
    icon: <Heading2 {...iconProps} />,
    id: "heading-2",
    isActive: (editor) => editor.isActive("heading", { level: 2 }),
    label: "Heading 2"
  },
  {
    icon: <Heading3 {...iconProps} />,
    id: "heading-3",
    isActive: (editor) => editor.isActive("heading", { level: 3 }),
    label: "Heading 3"
  }
];

const listControls: readonly BlockControl[] = [
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
  },
  {
    icon: <Quote {...iconProps} />,
    id: "blockquote",
    isActive: (editor) => editor.isActive("blockquote"),
    label: "Quote"
  },
  {
    icon: <SquareCode {...iconProps} />,
    id: "code-block",
    isActive: (editor) => editor.isActive("codeBlock"),
    label: "Code block"
  }
];

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

export function EditorToolbar({ editor }: Readonly<{ editor: Editor }>): React.JSX.Element {
  return (
    <div aria-label="Formatting" className={editorToolbarClassNames.root} role="toolbar">
      <div className={editorToolbarClassNames.group} role="group">
        {[...blockControls, ...listControls].map((control) => (
          <IconButton
            aria-pressed={control.isActive(editor)}
            icon={control.icon}
            key={control.id}
            label={control.label}
            onClick={() => runBlockCommandById(editor, control.id)}
            variant={control.isActive(editor) ? "secondary" : "ghost"}
          />
        ))}
      </div>

      <span aria-hidden className={editorToolbarClassNames.divider} />

      <div className={editorToolbarClassNames.group} role="group">
        {markControls.map((control) => (
          <IconButton
            aria-pressed={editor.isActive(control.mark)}
            icon={control.icon}
            key={control.mark}
            label={control.label}
            onClick={() => control.toggle(editor)}
            variant={editor.isActive(control.mark) ? "secondary" : "ghost"}
          />
        ))}
      </div>

      <span aria-hidden className={editorToolbarClassNames.divider} />

      <div className={editorToolbarClassNames.group} role="group">
        <IconButton
          disabled={!editor.can().undo()}
          icon={<Undo2 {...iconProps} />}
          label="Undo"
          onClick={() => editor.commands.undo()}
          variant="ghost"
        />
        <IconButton
          disabled={!editor.can().redo()}
          icon={<Redo2 {...iconProps} />}
          label="Redo"
          onClick={() => editor.commands.redo()}
          variant="ghost"
        />
      </div>
    </div>
  );
}
