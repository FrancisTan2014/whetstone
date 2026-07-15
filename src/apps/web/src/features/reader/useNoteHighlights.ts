import { useEffect } from "react";

import type { AnchoredNoteDto } from "@whetstone/contracts";

import { applyNoteHighlights } from "./applyNoteHighlights";

// Apply note annotations as render-time DOM decorations over the rendered reader (#313). The
// highlights live outside React's tree (injected spans over the rendered blocks), so this hook
// re-applies them whenever the notes or the rendered content change — `renderKey` changes when the
// active unit or the briefly-remounted born block changes, restoring a highlight that a remount would
// otherwise drop. The spans are inert decoration (#555); opening a note is the block's edge opener's
// job, so this hook no longer wires any click/keyboard activation.
export function useNoteHighlights(notes: ReadonlyArray<AnchoredNoteDto>, renderKey: string): void {
  useEffect(() => {
    const container = document.querySelector(".reader");

    if (container === null) {
      return undefined;
    }

    return applyNoteHighlights(container, notes);
    // `renderKey` re-applies the highlights after the rendered blocks change (unit switch / born
    // remount); `notes` re-applies when the annotations themselves change.
  }, [notes, renderKey]);
}
