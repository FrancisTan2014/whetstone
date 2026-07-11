import type { Editor, Extensions } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor } from "@tiptap/react";
import {
  type DocumentNodeJSON,
  documentExtensions,
  parseDocument,
  serializeDocument
} from "@whetstone/document";
import { useEffect, useId, useMemo, useState } from "react";

import { Button } from "../ui/Button.js";
import {
  editorDocumentsEqual,
  normalizeEditorLinkHref,
  validateEditorDocument
} from "./editorDocument.js";
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

interface FormatButtonProps {
  readonly active: boolean;
  readonly children: React.ReactNode;
  readonly label: string;
  readonly onClick: () => void;
}

function FormatButton({ active, children, label, onClick }: FormatButtonProps): React.JSX.Element {
  return (
    <Button
      aria-label={label}
      aria-pressed={active}
      className={editorClassNames.action}
      onClick={onClick}
      size="sm"
      variant={active ? "secondary" : "ghost"}
    >
      {children}
    </Button>
  );
}

function snapshot(editor: Editor): DocumentNodeJSON {
  return serializeDocument(parseDocument(editor.getJSON()));
}

function currentBlockStyle(editor: Editor): string {
  for (const level of [1, 2, 3]) {
    if (editor.isActive("heading", { level })) {
      return `heading-${level}`;
    }
  }

  return "paragraph";
}

function isSaveShortcut(event: KeyboardEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s";
}

export function RichContentEditor({
  ariaLabel = "Rich content editor",
  document,
  onChange,
  onSave,
  presentation = "full"
}: RichContentEditorProps): React.JSX.Element {
  const initialDocument = useMemo(() => validateEditorDocument(document), [document]);
  const [expanded, setExpanded] = useState(false);
  const [linkInput, setLinkInput] = useState("");
  const [linkError, setLinkError] = useState<string>();
  const linkErrorId = useId();
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
    return <div aria-busy="true" className={editorClassNames.root} />;
  }

  const showFullToolbar = presentation === "full" || expanded;
  const applyLink = (): void => {
    const trimmed = linkInput.trim();

    if (trimmed === "") {
      editor.chain().focus().unsetMark("link", { extendEmptyMarkRange: true }).run();
      setLinkError(undefined);
      return;
    }

    const href = normalizeEditorLinkHref(trimmed);
    if (href === undefined) {
      setLinkError("Use an http, https, mailto, anchor, or root-relative link.");
      return;
    }

    editor.chain().focus().setMark("link", { href }).run();
    setLinkError(undefined);
  };
  const removeLink = (): void => {
    editor.chain().focus().unsetMark("link", { extendEmptyMarkRange: true }).run();
    setLinkError(undefined);
  };

  return (
    <div className={editorClassNames.root} data-presentation={showFullToolbar ? "full" : "compact"}>
      <div aria-label="Text formatting" className={editorClassNames.toolbar} role="toolbar">
        {showFullToolbar ? (
          <>
            <label>
              <span className="sr-only">Block style</span>
              <select
                aria-label="Block style"
                className={editorClassNames.blockStyle}
                onChange={(event) => {
                  const value = event.currentTarget.value;

                  if (value === "paragraph") {
                    editor.chain().focus().setNode("paragraph").run();
                    return;
                  }

                  editor
                    .chain()
                    .focus()
                    .setNode("heading", { level: Number(value.replace("heading-", "")) })
                    .run();
                }}
                value={currentBlockStyle(editor)}
              >
                <option value="paragraph">Paragraph</option>
                <option value="heading-1">Heading 1</option>
                <option value="heading-2">Heading 2</option>
                <option value="heading-3">Heading 3</option>
              </select>
            </label>
            <FormatButton
              active={editor.isActive("bulletList")}
              label="Bullet list"
              onClick={() => editor.chain().focus().toggleList("bulletList", "listItem").run()}
            >
              Bullets
            </FormatButton>
            <FormatButton
              active={editor.isActive("orderedList")}
              label="Ordered list"
              onClick={() => editor.chain().focus().toggleList("orderedList", "listItem").run()}
            >
              Numbered
            </FormatButton>
            <FormatButton
              active={editor.isActive("blockquote")}
              label="Blockquote"
              onClick={() => editor.chain().focus().toggleWrap("blockquote").run()}
            >
              Quote
            </FormatButton>
            <FormatButton
              active={editor.isActive("codeBlock")}
              label="Code block"
              onClick={() => editor.chain().focus().toggleNode("codeBlock", "paragraph").run()}
            >
              Code block
            </FormatButton>
          </>
        ) : null}
        <FormatButton
          active={editor.isActive("bold")}
          label="Bold"
          onClick={() => editor.chain().focus().toggleMark("bold").run()}
        >
          Bold
        </FormatButton>
        <FormatButton
          active={editor.isActive("italic")}
          label="Italic"
          onClick={() => editor.chain().focus().toggleMark("italic").run()}
        >
          Italic
        </FormatButton>
        <FormatButton
          active={editor.isActive("code")}
          label="Inline code"
          onClick={() => editor.chain().focus().toggleMark("code").run()}
        >
          Inline code
        </FormatButton>
        <Button
          aria-label="Undo"
          className={editorClassNames.action}
          disabled={!editor.can().undo()}
          onClick={() => editor.chain().focus().undo().run()}
          size="sm"
          variant="ghost"
        >
          Undo
        </Button>
        <Button
          aria-label="Redo"
          className={editorClassNames.action}
          disabled={!editor.can().redo()}
          onClick={() => editor.chain().focus().redo().run()}
          size="sm"
          variant="ghost"
        >
          Redo
        </Button>
        {!showFullToolbar ? (
          <Button
            aria-label="Expand editor"
            className={editorClassNames.action}
            onClick={() => setExpanded(true)}
            size="sm"
            variant="secondary"
          >
            More
          </Button>
        ) : null}
        {onSave === undefined ? null : (
          <Button
            aria-label="Save document"
            className={editorClassNames.action}
            onClick={() => onSave(snapshot(editor))}
            size="sm"
          >
            Save
          </Button>
        )}
        {showFullToolbar ? (
          <>
            <label className={editorClassNames.linkField}>
              <span className="sr-only">Link URL</span>
              <input
                aria-describedby={linkError === undefined ? undefined : linkErrorId}
                aria-invalid={linkError === undefined ? undefined : true}
                aria-label="Link URL"
                className={editorClassNames.linkInput}
                onChange={(event) => setLinkInput(event.currentTarget.value)}
                placeholder="https://example.com"
                inputMode="url"
                type="text"
                value={linkInput}
              />
            </label>
            <Button onClick={applyLink} size="sm" variant="secondary">
              Apply link
            </Button>
            <Button onClick={removeLink} size="sm" variant="ghost">
              Remove link
            </Button>
          </>
        ) : null}
      </div>
      {linkError === undefined ? null : (
        <p className={editorClassNames.error} id={linkErrorId} role="alert">
          {linkError}
        </p>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
