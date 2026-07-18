import type { Editor, Extensions } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus";
import { MoreHorizontal } from "lucide-react";
import {
  type DocumentNodeJSON,
  documentExtensions,
  parseDocument,
  serializeDocument
} from "@whetstone/document";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "../ui/Button.js";
import { useFloatingLayerContainer } from "../ui/FloatingLayer.js";
import { useMediaQuery } from "../ui/useMediaQuery.js";
import { BlockActionsMenu } from "./BlockActionsMenu.js";
import { blockActionsMenuClassNames } from "./BlockActionsMenu.tokens.js";
import { resolveTopLevelBlock } from "./blockGutterCommands.js";
import { BlockGutterHandle } from "./BlockGutterHandle.js";
import { BlockGutterHighlight, setBlockGutterTarget } from "./blockGutterHighlight.js";
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
// The slash extension is added per-instance in the component so its portal container can be threaded
// from the shared floating layer (#645); everything here is stateless and container-agnostic.
const baseExtensions: Extensions = [
  ...(documentExtensions as unknown as Extensions),
  UndoRedo,
  // The transient gutter wash — an editing-only decoration the static reader never mounts (#590).
  BlockGutterHighlight as unknown as Extensions[number],
  // A restrained, decoration-only hint on a focused empty paragraph — never stored, copied, or read
  // by the static reader (which mounts `documentExtensions` without this editing-only extension).
  Placeholder.configure({
    placeholder: ({ node }) => (node.type.name === "paragraph" ? "Type / for commands" : ""),
    showOnlyCurrent: true
  })
];

// The gutter is a pointer affordance: it only makes sense with a fine, hovering pointer. On touch or a
// coarse pointer the compact `More block actions` trigger carries the same menu instead (#590).
const POINTER_GUTTER_QUERY = "(hover: hover) and (pointer: fine)";

// Which surface owns the open menu, so the two anchored instances (the hover gutter grip and the
// compact/keyboard trigger) never open at once.
type OpenMenu = { readonly pos: number; readonly source: "gutter" | "more" };

export type RichContentEditorPresentation = "compact" | "full";

export interface RichContentEditorProps {
  readonly ariaLabel?: string;
  readonly document: DocumentNodeJSON;
  // When false the editor is read-only (Tiptap's native `editable`): the content stays visible but every
  // edit is blocked. Consumers freeze the surface this way (e.g. an in-flight import). Defaults to true.
  readonly editable?: boolean;
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

// The document position just before the top-level block the selection sits in — the same value the
// drag handle reports on hover, so keyboard (`Shift+F10`) and compact access target the exact block a
// pointer would. Falls back to the document start for an empty selection at the very top.
// The document position just before the top-level block the selection sits in — the exact value the
// drag handle reports on hover, so keyboard (`Shift+F10`) and compact access target the same block a
// pointer would. Takes an `EditorState` so both the live editor and the ProseMirror view handed to
// `handleKeyDown` resolve it identically.
function activeBlockStart(state: EditorState): number {
  const block = resolveTopLevelBlock(state.doc, state.selection.from);
  /* v8 ignore next -- a focused selection always resolves to a top-level block; the 0 fallback only
     guards a document-end gap cursor, unreachable from the menu surfaces and covered by
     resolveTopLevelBlock's own unit tests. Its result is still asserted through the reorder tests. */
  return block?.start ?? 0;
}

// The horizontal ellipsis for the compact/touch `More block actions` trigger.
function MoreIcon(): React.JSX.Element {
  return <MoreHorizontal aria-hidden height={16} strokeWidth={1.75} width={16} />;
}

// The shared editing surface: a document-first writing area with no permanent chrome. Inline
// formatting lives in a contextual toolbar (Tiptap's BubbleMenu) beside a real text selection, block
// transforms live on the slash menu (#588), and the block structure surfaces only on interaction
// through the contextual gutter (#590): hovering a top-level block reveals one grip that opens the
// block-actions menu and drags to reorder, while touch/keyboard reach the same menu through a compact
// trigger and `Shift+F10`. Save state belongs to the consuming page.
export function RichContentEditor({
  ariaLabel = "Rich content editor",
  document,
  editable = true,
  onChange,
  onSave,
  presentation = "full"
}: RichContentEditorProps): React.JSX.Element {
  const initialDocument = useMemo(() => validateEditorDocument(document), [document]);
  const visibility = useMemo(() => createFormattingMenuVisibility(), []);
  const showPointerGutter = useMediaQuery(POINTER_GUTTER_QUERY);
  // The shared floating-layer boundary (#645): where the toolbar, link form, slash menu, and
  // block-actions menu portal. Outside a `Sheet` it resolves to `document.body`; inside one the Sheet
  // hands down an above-overlay host so every surface stays visible and interactive over the modal.
  const container = useFloatingLayerContainer();
  const editorExtensions = useMemo<Extensions>(
    () => [...baseExtensions, SlashCommand.configure({ container })],
    [container]
  );
  // The block whose grip is currently hovered/focused (pointer gutter), and the open menu, if any.
  const [gutterPos, setGutterPos] = useState<number | null>(null);
  const [openMenu, setOpenMenu] = useState<OpenMenu | null>(null);
  // The BubbleMenu re-dispatches an `updateOptions` transaction whenever these props change identity;
  // with `shouldRerenderOnTransaction` that would loop, so keep them referentially stable. The
  // container getter is itself stable (a module constant outside a provider, a memoized getter inside).
  const bubbleAppendTo = useCallback(() => container(), [container]);
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
    editable,
    editorProps: {
      attributes: {
        "aria-label": ariaLabel,
        "aria-multiline": "true",
        class: editorClassNames.content,
        role: "textbox"
      },
      handleKeyDown: (view, event) => {
        // Shift+F10 is the keyboard equivalent of hovering the gutter: open the block-actions menu for
        // the block the caret sits in. Routed through the compact ("more") surface so touch/keyboard
        // and pointer share one menu instance and open state. ProseMirror does not route key events
        // through this handler on a read-only surface, and read-only mounts no menu, so it stays inert.
        if (event.shiftKey && event.key === "F10") {
          event.preventDefault();
          setOpenMenu({ pos: activeBlockStart(view.state), source: "more" });
          return true;
        }

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

  // Reflect a changed `editable` onto the live editor (Tiptap's native read-only toggle): freezing an
  // in-flight surface after mount must actually block edits, not only at first render.
  useEffect(() => {
    if (editor === null) {
      return;
    }

    editor.setEditable(editable);
  }, [editor, editable]);

  // Paint the transient wash on the block that owns the interaction: the open menu's block when a menu
  // is open, otherwise the hovered gutter block. Clears (null) at rest. The decoration is a no-op
  // transaction, so it never edits the document, enters undo, or emits onChange.
  useEffect(() => {
    if (editor === null) {
      return;
    }

    setBlockGutterTarget(editor, openMenu !== null ? openMenu.pos : gutterPos);
  }, [editor, openMenu, gutterPos]);

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
        <EditorFormattingMenu
          container={container}
          editor={editor}
          onEscape={dismissFormattingMenu}
        />
      </BubbleMenu>

      {showPointerGutter && editable ? (
        <BlockGutterHandle
          container={container}
          editor={editor}
          gutterPos={gutterPos}
          onGutterPosChange={setGutterPos}
          onMenuChange={setOpenMenu}
          openMenu={openMenu}
        />
      ) : null}

      {/* Block actions mutate the document, so a read-only surface (editable=false) mounts none of this
          chrome — no compact trigger, no gutter, no Shift+F10 — and cannot be edited through it. */}
      {editable ? (
        <div className={editorClassNames.moreActions}>
          <BlockActionsMenu
            container={container}
            editor={editor}
            onOpenChange={(open) =>
              setOpenMenu(open ? { pos: activeBlockStart(editor.state), source: "more" } : null)
            }
            open={openMenu?.source === "more"}
            pos={openMenu?.source === "more" ? openMenu.pos : activeBlockStart(editor.state)}
            trigger={
              <Button
                aria-label="More block actions"
                className={blockActionsMenuClassNames.moreTrigger}
                size="sm"
                variant="ghost"
              >
                <MoreIcon />
              </Button>
            }
          />
        </div>
      ) : null}

      <EditorContent editor={editor} />
    </div>
  );
}
