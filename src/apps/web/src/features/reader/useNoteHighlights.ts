import { useEffect } from "react";

import type { NoteDto } from "@whetstone/contracts";

import { applyNoteHighlights } from "./applyNoteHighlights";
import { eventTargetClosest } from "./selectionCapture";

// Apply note annotations as render-time DOM decorations over the rendered reader and route a
// click / Enter on a highlight to its note (#313). The highlights live outside React's tree (injected
// spans over the rendered blocks), so this hook re-applies them whenever the notes or the rendered
// content change — `renderKey` changes when the active unit or the briefly-remounted born block
// changes, restoring a highlight that a remount would otherwise drop.
export function useNoteHighlights(
  notes: ReadonlyArray<NoteDto>,
  onActivateNote: (noteId: string) => void,
  renderKey: string
): void {
  useEffect(() => {
    const container = document.querySelector(".reader");

    if (container === null) {
      return undefined;
    }

    let cleanup = (): void => {};
    let cancelled = false;

    void applyNoteHighlights(container, notes).then((remove) => {
      if (cancelled) {
        remove();
      } else {
        cleanup = remove;
      }
    });

    return () => {
      cancelled = true;
      cleanup();
    };
    // `renderKey` re-applies the highlights after the rendered blocks change (unit switch / born
    // remount); `notes` re-applies when the annotations themselves change.
  }, [notes, renderKey]);

  useEffect(() => {
    function onActivate(event: Event): void {
      const mark = eventTargetClosest(event.target, "[data-note-id]");

      if (mark === null) {
        return;
      }

      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") {
        return;
      }

      if (event.type === "keydown") {
        event.preventDefault();
      }

      const noteId = mark.getAttribute("data-note-id");

      /* v8 ignore next 3 -- `mark` matched `[data-note-id]`, so the attribute is always a string;
         the guard only narrows the type for the compiler and is never taken at runtime. */
      if (noteId === null) {
        return;
      }

      onActivateNote(noteId);
    }

    document.addEventListener("click", onActivate);
    document.addEventListener("keydown", onActivate);

    return () => {
      document.removeEventListener("click", onActivate);
      document.removeEventListener("keydown", onActivate);
    };
  }, [onActivateNote]);
}
