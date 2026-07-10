import { useCallback, useEffect, useRef, useState } from "react";

import type { DocumentNodeJSON } from "@whetstone/document";

// The debounce before an idle edit is persisted. Long enough that continuous typing coalesces into one
// save, short enough that a pause is captured promptly.
export const autosaveDelayMs = 800;

// The states the editor surfaces (#576): the loaded document is untouched ("idle"), an edit is pending
// the debounce ("unsaved"), a save is in flight ("saving"), everything is persisted ("saved"), or the
// last save failed ("error"). "saved" is only reported after the server has stored the latest document,
// so it never shows while edits are still pending.
export type AutosaveStatus = "idle" | "unsaved" | "saving" | "saved" | "error";

export type AutosaveController = Readonly<{
  // True whenever the on-screen document differs from what the server has confirmed — drives the
  // navigate-away warning so a pending or failed save is never discarded silently.
  hasUnsavedChanges: boolean;
  // Feed every editor change here; the latest document is what will be persisted (latest-write-safe).
  notifyChange: (document: DocumentNodeJSON) => void;
  // Flush any pending debounce and save immediately (explicit Save / before leaving).
  saveNow: () => void;
  status: AutosaveStatus;
}>;

// Persists the document. Injected so the hook is exercised with a fake save + fake timers; the real one
// calls `saveAuthoredWorkContent`. It must reject to signal a failed persist.
export type SaveDocument = (document: DocumentNodeJSON) => Promise<void>;

// Debounced, latest-write-safe autosave for the authored-Work editor. Saves are serialized (never two in
// flight), so out-of-order responses cannot clobber a newer write: when a change arrives mid-save the
// hook re-saves the latest document as soon as the current save settles, and only reports "saved" once
// the most recent document is the one the server confirmed. A failed save keeps the document pending and
// `hasUnsavedChanges` true so the caller can warn on navigation and a later edit (or `saveNow`) retries.
export function useAutosave(save: SaveDocument, delayMs: number = autosaveDelayMs): AutosaveController {
  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Refs hold the live values the timer/async callbacks read, so the debounce and save loop never close
  // over stale props or state.
  const saveRef = useRef(save);
  saveRef.current = save;
  const pendingRef = useRef<DocumentNodeJSON | undefined>(undefined);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  const setStatusIfMounted = useCallback((next: AutosaveStatus): void => {
    if (mountedRef.current) {
      setStatus(next);
    }
  }, []);

  const runSave = useCallback((): void => {
    if (savingRef.current) {
      return;
    }

    const document = pendingRef.current;
    if (document === undefined) {
      return;
    }

    savingRef.current = true;
    pendingRef.current = undefined;
    setStatusIfMounted("saving");

    saveRef.current(document).then(
      () => {
        savingRef.current = false;
        if (pendingRef.current === undefined) {
          setStatusIfMounted("saved");
          if (mountedRef.current) {
            setHasUnsavedChanges(false);
          }
          return;
        }
        // A newer edit landed while this save was in flight — persist it too, staying in "saving".
        runSave();
      },
      () => {
        savingRef.current = false;
        // Keep the document pending (unless a newer edit already replaced it) so a retry can save it,
        // and leave `hasUnsavedChanges` true so navigation warns.
        if (pendingRef.current === undefined) {
          pendingRef.current = document;
        }
        setStatusIfMounted("error");
      }
    );
  }, [setStatusIfMounted]);

  const notifyChange = useCallback(
    (document: DocumentNodeJSON): void => {
      pendingRef.current = document;
      if (mountedRef.current) {
        setHasUnsavedChanges(true);
      }
      // While a save is in flight the loop already shows "saving" and will re-save this newer document,
      // so don't downgrade the indicator; otherwise reflect the pending edit honestly.
      if (!savingRef.current) {
        setStatusIfMounted("unsaved");
      }
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(runSave, delayMs);
    },
    [delayMs, runSave, setStatusIfMounted]
  );

  const saveNow = useCallback((): void => {
    clearTimeout(timerRef.current);
    runSave();
  }, [runSave]);

  useEffect(
    () => () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
    },
    []
  );

  return { hasUnsavedChanges, notifyChange, saveNow, status };
}
