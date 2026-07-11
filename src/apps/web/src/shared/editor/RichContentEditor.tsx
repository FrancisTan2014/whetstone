import type { Editor, Extensions } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import {
  type DocumentNodeJSON,
  documentExtensions,
  parseDocument,
  serializeDocument
} from "@whetstone/document";
import { useCallback, useEffect, useMemo } from "react";

import {
  createFormattingMenuVisibility,
  type FormattingMenuSelection
} from "./bubbleFormatting.js";
import { EditorFormattingMenu } from "./EditorFormattingMenu.js";
import { editorDocumentsEqual, validateEditorDocument } from "./editorDocument.js";
import { editorClassNames } from "./RichContentEditor.tokens.js";
import { SlashCommand } from "./slashCommand.js";

// pnpm exposes the same Tiptap runtime through the document and web workspace package boundaries,
// but TypeScript treats Tiptap's privately-branded extension classes as nominal across their emitted
// declarations. Narrow once at this integration seam; the runtime objects are the shared instances.
const editorExtensions: Extensions = [
  ...(documentExtensions as unknown as Extensions),
  UndoRedo,
  SlashCommand,
  // A restrained, decoration-only hint on a focused empty paragraph — never stored, copied, or read
  // by the static reader (which mounts `documentExtensions` without this editing-only extension).
  Placeholder.configure({
    placeholder: ({ node }) => (node.type.name === "paragraph" ? "Type / for commands" : ""),
    showOnlyCurrent: true
  })
];

export type RichContentEditorPresentation = "compact" | "full";

export interface RichContentEditorProps {
  readonly ariaLabel?: string;
  readonly document: DocumentNodeJSON;
  readonly onChange: (document: DocumentNodeJSON) => void;
  readonly onSave?: (document: DocumentNodeJSON) => void;
  readonly presentation?: RichContentEditorPresentation;
}

function snapshot(editor: Editor): DocumentNodeJSON {
  return serializeDocument(parseDocument(editor.getJSON()));
}

function isSaveShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
}

// The shared editing surface: a document-first writing area with no permanent chrome. Inline
// formatting lives in a contextual toolbar (Tiptap's BubbleMenu) that appears beside a real text
// selection, block transforms live on the slash menu (#588), and save state belongs to the consuming
// page. Mark, undo/redo, and save keyboard shortcuts keep working without any visible buttons.
export function RichContentEditor({
  ariaLabel = "Rich content editor",
  document,
  onChange,
  onSave,
  presentation = "full"
}: RichContentEditorProps): React.JSX.Element {
  const initialDocument = useMemo(() => validateEditorDocument(document), [document]);
  const visibility = useMemo(() => createFormattingMenuVisibility(), []);
  // The BubbleMenu re-dispatches an `updateOptions` transaction whenever these props change identity;
  // with `shouldRerenderOnTransaction` that would loop, so keep them referentially stable.
  const bubbleAppendTo = useCallback(() => window.document.body, []);
  const bubbleOptions = useMemo<NonNullable<BubbleMenuProps["options"]>>(
    () => ({ flip: {}, offset: 8, placement: "top", shift: { padding: 8 } }),
    []
  );
  const bubbleShouldShow = useCallback<NonNullable<BubbleMenuProps["shouldShow"]>>(
    (props) => visibility.shouldShow(props as unknown as FormattingMenuSelection),
    [visibility]
  );
  const editor = useEditor({
    content: initialDocument,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        class: editorClassNames.content,
        role: "textbox"
      },
      handleKeyDown: (view, event) => {
        if (onSave === undefined || !isSaveShortcut(event)) {
          return false;
        }

        event.preventDefault();
        onSave(validateEditorDocument(view.state.doc.toJSON()));
        return true;
      }
    },
    extensions: editorExtensions,
    immediatelyRender: false,
    onUpdate: ({ editor: updatedEditor }) => {
      onChange(snapshot(updatedEditor));
    },
    shouldRerenderOnTransaction: true
  });

  useEffect(() => {
    if (editor === null) {
      return;
    }

    const current = snapshot(editor);
    if (!editorDocumentsEqual(current, initialDocument)) {
      editor.commands.setContent(initialDocument, { emitUpdate: false });
    }
  }, [editor, initialDocument]);

  if (editor === null) {
    return (
      <div aria-busy="true" className={editorClassNames.root} data-presentation={presentation} />
    );
  }

  const dismissFormattingMenu = (): void => {
    const { from, to } = editor.state.selection;
    visibility.dismiss(from, to);
    editor.chain().focus().run();
  };

  return (
    <div className={editorClassNames.root} data-presentation={presentation}>
      <BubbleMenu
        appendTo={bubbleAppendTo}
        editor={editor}
        options={bubbleOptions}
        shouldShow={bubbleShouldShow}
        updateDelay={0}
      >
        <EditorFormattingMenu editor={editor} onEscape={dismissFormattingMenu} />
      </BubbleMenu>
      <EditorContent editor={editor} />
    </div>
  );
}
