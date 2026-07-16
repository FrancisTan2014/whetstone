import { useEffect, useRef } from "react";

import type { AnchoredNoteDto } from "@whetstone/contracts";

import { applyNoteHighlights } from "./applyNoteHighlights";
import { resolveActivatedNotes, type NoteActivation } from "./noteActivation";

// Apply note annotations as render-time DOM decorations over the rendered reader (#313). The
// highlights live outside React's tree (injected spans over the rendered blocks), so this hook
// re-applies them whenever the notes or the rendered content change — `renderKey` changes when the
// active unit or the briefly-remounted born block changes, restoring a highlight that a remount would
// otherwise drop. Each underline is the annotation's direct activation target (#644): activating one
// resolves the covering note(s) and calls `onActivate` so the reader opens that exact note, or a
// chooser only where annotations genuinely overlap. `onActivate` is held in a ref so a new handler
// identity never re-applies (unwraps/rewraps) the highlights.
export function useNoteHighlights(
  notes: ReadonlyArray<AnchoredNoteDto>,
  renderKey: string,
  onActivate: (activation: NoteActivation) => void
): void {
  const onActivateRef = useRef(onActivate);

  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    const container = document.querySelector(".reader");

    if (container === null) {
      return undefined;
    }

    return applyNoteHighlights(container, notes, (noteIds) => {
      const activation = resolveActivatedNotes(noteIds, notes);

      if (activation !== undefined) {
        onActivateRef.current(activation);
      }
    });
    // `renderKey` re-applies the highlights after the rendered blocks change (unit switch / born
    // remount); `notes` re-applies when the annotations themselves change.
  }, [notes, renderKey]);
}
