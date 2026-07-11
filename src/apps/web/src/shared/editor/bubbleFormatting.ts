import type { Editor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

// The arguments Tiptap's BubbleMenu passes to `shouldShow`. Modelled locally so the visibility rule
// stays a pure predicate that can be unit tested without mounting an editor.
export interface FormattingMenuSelection {
  readonly editor: Editor;
  readonly element: HTMLElement;
  readonly view: EditorView;
  readonly state: EditorState;
  readonly from: number;
  readonly to: number;
}

export interface FormattingMenuVisibility {
  /** Whether the contextual toolbar should be visible for the given selection. */
  readonly shouldShow: (selection: FormattingMenuSelection) => boolean;
  /** Hide the toolbar until the selection changes away from this range (Escape dismissal). */
  readonly dismiss: (from: number, to: number) => void;
}

// A formatting command only makes sense when the editor is editable and focused (either the document
// itself, or a control inside the toolbar element), and the selection covers real text. A collapsed
// caret or a node selection (image, figure) contributes no text between `from` and `to`, so it is
// excluded — matching Tiptap's own default while staying independent of its internals.
function isFormattableSelection({
  editor,
  element,
  view,
  state,
  from,
  to
}: FormattingMenuSelection): boolean {
  const focused = view.hasFocus() || element.contains(document.activeElement);

  return (
    editor.isEditable &&
    focused &&
    !state.selection.empty &&
    state.doc.textBetween(from, to).length > 0
  );
}

// Builds the toolbar's visibility gate. It layers a single dismissal on top of the selection rule so
// Escape can close the toolbar (`dismiss`) while a later, different selection re-opens it — the key
// resets automatically as soon as the selection moves off the dismissed range.
export function createFormattingMenuVisibility(): FormattingMenuVisibility {
  let dismissedKey: string | null = null;

  return {
    shouldShow: (selection) => {
      const key = `${String(selection.from)}:${String(selection.to)}`;

      if (dismissedKey !== null && dismissedKey !== key) {
        dismissedKey = null;
      }

      if (dismissedKey === key) {
        return false;
      }

      return isFormattableSelection(selection);
    },
    dismiss: (from, to) => {
      dismissedKey = `${String(from)}:${String(to)}`;
    }
  };
}
