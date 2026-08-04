import { useEffect, useRef } from "react";

import type { AnchoredNoteDto } from "@whetstone/contracts";

import { applyNoteHighlights } from "./applyNoteHighlights";
import { resolveActivatedNotes, type NoteActivation } from "./noteActivation";

// A guard the reader arms around the note-highlight DOM surgery so a selection the surgery collapses
// is not mistaken for the learner clearing their selection (#825). `begin` arms it before the
// unwrap/re-wrap; `end` releases it on the next tick, after the async `selectionchange` the collapse
// schedules has been ignored. See `ReaderPage` for the implementation and why the release is deferred.
export type NoteReapplyGuard = Readonly<{
  begin: () => void;
  end: () => void;
}>;

// Apply note annotations as render-time DOM decorations over the rendered reader (#313). The
// highlights live outside React's tree (injected spans over the rendered blocks), so this hook
// re-applies them whenever the notes or the rendered content change — `renderKey` changes when the
// active unit or the briefly-remounted born block changes, restoring a highlight that a remount would
// otherwise drop. Each underline is the annotation's direct activation target (#644): activating one
// resolves the covering note(s) and calls `onActivate` so the reader opens that exact note, or a
// chooser only where annotations genuinely overlap. `onActivate` is held in a ref so a new handler
// identity never re-applies (unwraps/rewraps) the highlights. An optional `reapplyGuard` (also held in
// a ref) brackets the unwrap/re-wrap so a re-application never dismisses an open selection toolbar.
export function useNoteHighlights(
  notes: ReadonlyArray<AnchoredNoteDto>,
  renderKey: string,
  onActivate: (activation: NoteActivation) => void,
  reapplyGuard?: NoteReapplyGuard
): void {
  const onActivateRef = useRef(onActivate);
  const reapplyGuardRef = useRef(reapplyGuard);

  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);

  useEffect(() => {
    reapplyGuardRef.current = reapplyGuard;
  }, [reapplyGuard]);

  useEffect(() => {
    const container = document.querySelector(".reader");

    if (container === null) {
      return undefined;
    }

    // Bracket the highlight DOM surgery (unwrap + re-wrap of `.noteMark` spans) — both the apply here
    // and the returned cleanup's unwrap — so a selection the surgery collapses does not dismiss an
    // open selection toolbar: the guard is armed before the surgery and released a tick after, so the
    // async `selectionchange` the collapse schedules is honoured as reader-driven, never as the
    // learner clearing their own selection (#825).
    reapplyGuardRef.current?.begin();
    const cleanup = applyNoteHighlights(container, notes, (noteIds) => {
      const activation = resolveActivatedNotes(noteIds, notes);

      if (activation !== undefined) {
        onActivateRef.current(activation);
      }
    });
    reapplyGuardRef.current?.end();

    return () => {
      reapplyGuardRef.current?.begin();
      cleanup();
      reapplyGuardRef.current?.end();
    };
    // `renderKey` re-applies the highlights after the rendered blocks change (unit switch / born
    // remount); `notes` re-applies when the annotations themselves change.
  }, [notes, renderKey]);
}
