import { useCallback, useEffect, useMemo, useState } from "react";

import type { AuthoredWorkDto } from "@whetstone/contracts";
import type { DocumentNodeJSON } from "@whetstone/document";

import { RichContentEditor } from "../../shared/editor/index.js";
import { Button } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { PmDocument } from "../reader/PmDocument.js";
import { fetchAuthoredWork, saveAuthoredWorkContent } from "./authoredWorkApi.js";
import { autosaveStatusClassNames, autosaveStatusLabels } from "./authoredWork.tokens.js";
import { useAutosave } from "./useAutosave.js";
import { useUnsavedChangesWarning } from "./useUnsavedChangesWarning.js";

// The authored-Work editor page (#576): an immersive writing surface reached at `#/write?work=<id>`,
// mirroring the reader. It loads the owned Work's canonical ProseMirror/Tiptap document, edits it in the
// shared rich editor with debounced latest-write-safe autosave, and reads it back through the very same
// reader renderer (`PmDocument`) with no format conversion. A missing/failed load or unknown id falls
// back to a calm inline state, never a blank page.

type LoadState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; work: AuthoredWorkDto }>;

type Mode = "edit" | "read";

export function AuthoredWorkPage({
  workEntryId
}: Readonly<{ workEntryId: string | undefined }>): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (workEntryId === undefined) {
      return;
    }

    let active = true;
    fetchAuthoredWork(workEntryId).then(
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

  if (workEntryId === undefined) {
    return (
      <WriteFrame>
        <p className="text-text-muted">No document selected. Open one from your Library.</p>
      </WriteFrame>
    );
  }

  if (load.status === "loading") {
    return (
      <WriteFrame>
        <LoadingIndicator label="Opening your document…" />
      </WriteFrame>
    );
  }

  if (load.status === "error") {
    return (
      <WriteFrame>
        <p className="text-text-muted" role="alert">
          Couldn&rsquo;t open this document. It may have been removed.
        </p>
      </WriteFrame>
    );
  }

  return <AuthoredWorkEditor key={load.work.entryId} work={load.work} />;
}

// The immersive shell around the writing surface: a quiet header with a way back to the Library, and the
// content region. Kept separate so the loading/error/empty arms share the same calm frame.
function WriteFrame({
  children,
  header
}: Readonly<{ children: React.ReactNode; header?: React.ReactNode }>): React.JSX.Element {
  return (
    <section aria-labelledby="write-heading" className="mx-auto max-w-3xl p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <a className="text-sm text-text-muted hover:text-text" href="#/library">
          ← Library
        </a>
        {header}
      </header>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AuthoredWorkEditor({ work }: Readonly<{ work: AuthoredWorkDto }>): React.JSX.Element {
  const [mode, setMode] = useState<Mode>("edit");
  const [draft, setDraft] = useState<DocumentNodeJSON>(work.document);
  // The editor is seeded once per edit session; reseeding only on read->edit keeps the latest content
  // without disrupting the cursor while typing (a per-keystroke reseed would fight the editor).
  const [editorSeed, setEditorSeed] = useState<DocumentNodeJSON>(work.document);

  const save = useCallback(
    async (document: DocumentNodeJSON): Promise<void> => {
      await saveAuthoredWorkContent(work.entryId, document);
    },
    [work.entryId]
  );
  const autosave = useAutosave(save);
  useUnsavedChangesWarning(autosave.hasUnsavedChanges);

  const handleChange = useCallback(
    (document: DocumentNodeJSON): void => {
      setDraft(document);
      autosave.notifyChange(document);
    },
    [autosave]
  );

  const handleExplicitSave = useCallback(
    (document: DocumentNodeJSON): void => {
      setDraft(document);
      autosave.notifyChange(document);
      autosave.saveNow();
    },
    [autosave]
  );

  const enterRead = useCallback((): void => {
    setMode("read");
  }, []);

  const enterEdit = useCallback((): void => {
    setEditorSeed(draft);
    setMode("edit");
  }, [draft]);

  const header = useMemo(
    () => (
      <div className="flex items-center gap-3">
        <p
          aria-live="polite"
          className={`text-sm ${autosaveStatusClassNames[autosave.status]}`}
          role="status"
        >
          {autosaveStatusLabels[autosave.status]}
        </p>
        <div aria-label="View mode" className="flex gap-1" role="group">
          <Button
            aria-pressed={mode === "edit"}
            onClick={enterEdit}
            size="sm"
            variant={mode === "edit" ? "secondary" : "ghost"}
          >
            Edit
          </Button>
          <Button
            aria-pressed={mode === "read"}
            onClick={enterRead}
            size="sm"
            variant={mode === "read" ? "secondary" : "ghost"}
          >
            Read
          </Button>
        </div>
      </div>
    ),
    [autosave.status, enterEdit, enterRead, mode]
  );

  return (
    <WriteFrame header={header}>
      <h1 className="text-2xl font-semibold text-text" id="write-heading">
        {work.title}
      </h1>
      <div className="mt-4">
        {mode === "edit" ? (
          <RichContentEditor
            ariaLabel={`Edit ${work.title}`}
            document={editorSeed}
            onChange={handleChange}
            onSave={handleExplicitSave}
            presentation="full"
          />
        ) : (
          <article aria-label={`Read ${work.title}`}>
            <PmDocument document={draft} />
          </article>
        )}
      </div>
    </WriteFrame>
  );
}
