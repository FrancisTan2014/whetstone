import type { EditorState } from "@tiptap/pm/state";

// Whether a `/` typed at the current selection may open the slash menu. This is the editor-agnostic
// half of the suggestion `allow` gate (the suggestion utility already restricts the trigger to the
// start of a block or after whitespace): the menu must never open inside a code block, an inline-code
// run, or a link, where a literal slash has to keep typing normally. Kept pure over ProseMirror state
// so it can be exhaustively tested without an editor view.

const SUPPRESSING_MARKS = new Set(["code", "link"]);

export function isSlashContextAllowed(state: EditorState): boolean {
  const { $from } = state.selection;
  const parent = $from.parent;

  // Only prose textblocks host the menu; a code block keeps slashes verbatim.
  if (!parent.isTextblock || parent.type.name === "codeBlock") {
    return false;
  }

  // Marks at the cursor (from the text before it, plus any toggled-on stored marks): an inline-code
  // run or a link suppresses the menu so the slash types literally there.
  const activeMarks = state.storedMarks ?? $from.marks();

  return !activeMarks.some((mark) => SUPPRESSING_MARKS.has(mark.type.name));
}
