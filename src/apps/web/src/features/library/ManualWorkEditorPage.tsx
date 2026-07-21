import { useCallback, useEffect, useRef, useState } from "react";

import type { ManualWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { RichContentEditor, editorDocumentsEqualIgnoringIds } from "../../shared/editor/index.js";
import { Button } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { PageFrame } from "../../shared/ui/PageFrame.js";
import { fetchManualWork, saveManualWorkContent } from "./manualWorkApi.js";
import {
  manualEditorSaveStatusClassNames,
  manualEditorSaveStatusLabels
} from "./manualWorkEditor.tokens.js";

// The Library manual-Work editor (#720): the dedicated surface a learner reaches from a manual Work's
// "Edit content" action to edit its canonical ProseMirror/Tiptap document. It loads the owned Work,
// edits it in the shared rich editor with a persistent formatting toolbar, and saves EXPLICITLY (a Save
// button and Ctrl/Cmd+S) — never autosaves — carrying the loaded revision so a stale save is refused
// rather than silently overwriting a change made in another session. On a conflict the learner's local
// edits are kept and a repeat save overwrites the newer version. The reader/search/notes read the same
// blocks, so a saved passage reopens exactly as written.

// The learner always sees which state their edits are in: saved, unsaved, in flight, conflicted, or
// failed. `unsaved` covers local edits not yet sent; `conflict` and `error` are the two alert states.
export type ManualEditorSaveStatus =
  | "idle"
  | "unsaved"
  | "saving"
  | "saved"
  | "validation-error"
  | "conflict"
  | "error";

type LoadState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; work: ManualWorkDto }>;

// Warn before the browser unloads while edits the server has not confirmed would be lost, so an explicit
// save the learner has not made yet is never discarded silently on reload/close.
function useUnsavedGuard(active: boolean): void {
  useEffect(() => {
    if (!active) {
      return;
    }

    function warn(event: BeforeUnloadEvent): void {
      event.preventDefault();
      event.returnValue = "";
    }

    window.addEventListener("beforeunload", warn);

    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [active]);
}

export function ManualWorkEditorPage({
  workEntryId
}: Readonly<{ workEntryId: string }>): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    fetchManualWork(workEntryId).then(
      (work) => {
        if (active) {
          setLoad({ status: "ready", work });
        }
      },
      () => {
        if (active) {
          setLoad({ status: "error" });
        }
      }
    );

    return () => {
      active = false;
    };
  }, [workEntryId]);

  if (load.status === "loading") {
    return (
      <EditorFrame>
        <LoadingIndicator label="Opening this work…" />
      </EditorFrame>
    );
  }

  if (load.status === "error") {
    return (
      <EditorFrame>
        <p className="text-text-muted" role="alert">
          Couldn&rsquo;t open this work. It may have been removed, or it isn&rsquo;t one you can
          edit.
        </p>
      </EditorFrame>
    );
  }

  return <ManualWorkEditor key={load.work.entryId} work={load.work} />;
}

// The editor shell: a Library parent link, the work title, the save status + Save action, and the
// centered editing column. Shared by the loading/error arms so every state uses the same calm frame.
function EditorFrame({
  children,
  primaryAction,
  title = "Edit content"
}: Readonly<{
  children: React.ReactNode;
  primaryAction?: React.ReactNode;
  title?: string;
}>): React.JSX.Element {
  return (
    <PageFrame
      parentLink={{ label: "Library", to: "/library" }}
      primaryAction={primaryAction}
      title={title}
    >
      {children}
    </PageFrame>
  );
}

function ManualWorkEditor({
  work: initialWork
}: Readonly<{ work: ManualWorkDto }>): React.JSX.Element {
  const [work, setWork] = useState<ManualWorkDto>(initialWork);
  const [draft, setDraft] = useState<DocumentNodeJSON>(initialWork.document);
  // The last document the server confirmed. `dirty` is derived against it, so the status is truthful
  // even after an undo back to the saved content.
  const [savedDocument, setSavedDocument] = useState<DocumentNodeJSON>(initialWork.document);
  const [status, setStatus] = useState<ManualEditorSaveStatus>("saved");
  // A single in-flight save at a time: a rapid second Save/Ctrl+S while one is pending is ignored rather
  // than racing two writes.
  const savingRef = useRef(false);
  // The shared editor emits an onChange on mount (its normalization echo) and the latest confirmed
  // document changes after each save, so `handleChange` reads the saved baseline through a ref to stay a
  // stable callback while still comparing against the current baseline.
  const savedDocumentRef = useRef(savedDocument);
  useEffect(() => {
    savedDocumentRef.current = savedDocument;
  }, [savedDocument]);

  // Compare ignoring per-block ids: the editor stamps an id onto the freshly created work's `id: null`
  // paragraph, and a save may return server-assigned ids, so only a real content change is "unsaved".
  const dirty = !editorDocumentsEqualIgnoringIds(draft, savedDocument);
  useUnsavedGuard(dirty || status === "saving" || status === "conflict" || status === "error");

  const handleChange = useCallback((document: DocumentNodeJSON): void => {
    setDraft(document);
    // The editor's mount echo re-emits the loaded document with generated ids; only a real divergence
    // from the saved baseline is an unsaved edit, so opening a work reads "Saved" rather than "Unsaved
    // changes".
    setStatus((previous) =>
      previous === "saving"
        ? previous
        : editorDocumentsEqualIgnoringIds(document, savedDocumentRef.current)
          ? "saved"
          : "unsaved"
    );
  }, []);

  const save = useCallback(
    async (document: DocumentNodeJSON): Promise<void> => {
      if (savingRef.current) {
        return;
      }

      savingRef.current = true;
      setDraft(document);
      setStatus("saving");

      let result;
      try {
        result = await saveManualWorkContent(work.entryId, document, work.revision);
      } catch {
        savingRef.current = false;
        setStatus("error");
        return;
      }

      if (result.status === "saved") {
        setWork(result.work);
        setSavedDocument(result.work.document);
        setStatus("saved");
        savingRef.current = false;
        return;
      }

      // A malformed document the server refused (defensive: the editor produces valid documents). Keep
      // the local edits so the learner can adjust and retry rather than losing them.
      if (result.status === "invalid") {
        setStatus("validation-error");
        savingRef.current = false;
        return;
      }

      // A stale revision: another session saved in between. Keep the learner's local edits and adopt the
      // current revision, so pressing Save again deliberately overwrites the newer version.
      let latest;
      try {
        latest = await fetchManualWork(work.entryId);
      } catch {
        savingRef.current = false;
        setStatus("error");
        return;
      }

      setWork((previous) => ({
        ...previous,
        revision: latest.revision,
        updatedAt: latest.updatedAt
      }));
      setStatus("conflict");
      savingRef.current = false;
    },
    [work.entryId, work.revision]
  );

  const header = (
    <div className="flex items-center gap-3">
      <p
        aria-live="polite"
        className={`text-sm ${manualEditorSaveStatusClassNames[status]}`}
        role={
          status === "conflict" || status === "error" || status === "validation-error"
            ? "alert"
            : "status"
        }
      >
        {manualEditorSaveStatusLabels[status]}
      </p>
      <Button
        onClick={() => {
          void save(draft);
        }}
        pending={status === "saving"}
        size="sm"
        variant="primary"
      >
        {status === "conflict" ? "Save again" : "Save"}
      </Button>
    </div>
  );

  return (
    <EditorFrame primaryAction={header} title={work.title}>
      <div className="manualWorkEditorColumn">
        <RichContentEditor
          ariaLabel={`Edit ${work.title}`}
          document={initialWork.document}
          onChange={handleChange}
          onSave={(document) => {
            void save(document);
          }}
          presentation="full"
          showToolbar
        />
      </div>
    </EditorFrame>
  );
}
