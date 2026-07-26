import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DocumentNodeJSON } from "@whetstone/document";

import {
  RichContentEditor,
  editorDocumentsEqualIgnoringIds,
  type ExtractionEvidenceMap,
  validateEditorDocument
} from "../../shared/editor/index.js";
import { Button } from "../../shared/ui/Button.js";
import { PageFrame } from "../../shared/ui/PageFrame.js";
import type { ManualWorkSectionDto } from "@whetstone/contracts";
import {
  manualEditorSaveStatusClassNames,
  manualEditorSaveStatusLabels
} from "./manualWorkEditor.tokens.js";
import { projectDraftOutline, WorkOutline } from "./WorkOutline.js";

// The shared Library content editor (#720 manual, #762 imported correction): the responsive workspace an
// administrator reaches from a Work's edit/correct action to edit its ordered sections. A live Outline —
// derived only from the persisted heading blocks, never a stored tree — sits beside the shared rich editor
// with its persistent formatting toolbar. Selecting a section loads that ReadingUnit and focuses its
// heading; "Add section" appends a new heading-led ReadingUnit and opens it. Every write is EXPLICIT (a
// Save button and Ctrl/Cmd+S) and carries the work-level revision (#703), so a stale save/add is refused
// rather than silently overwriting another session; navigation saves the current section first and, on a
// failure/conflict, leaves the current draft, section, and active item unchanged. The editor is neutral to
// a Work's ORIGIN: the manual page and the imported-correction page inject a DTO plus an API adapter
// (`WorkEditorApi`) whose authority differs (owner-scoped vs administrative), but the editing surface,
// Outline, repartition, and revision protection are identical, so they generalize rather than fork.

// The learner always sees which state their edits are in: saved, unsaved, in flight, conflicted, or
// failed. `unsaved` covers local edits not yet sent; `conflict` and `error` are the two alert states.
export type WorkEditorSaveStatus =
  | "idle"
  | "unsaved"
  | "saving"
  | "saved"
  | "validation-error"
  | "conflict"
  | "error";

// The minimal Work shape the shared editor reads. Both the manual DTO and the imported-correction DTO are
// structurally supersets of this, so either satisfies it without the editor knowing the origin.
export type WorkEditorWork = Readonly<{
  document: DocumentNodeJSON;
  entryId: string;
  revision: number;
  sections: ReadonlyArray<ManualWorkSectionDto>;
  title: string;
  unitEntryId: string;
}>;

// A save either lands (returning the reopened Work at a new revision with recomputed sections), is refused
// because the loaded revision is stale, or is rejected because the document is invalid.
export type WorkEditorSaveResult<W extends WorkEditorWork> =
  | Readonly<{ status: "saved"; work: W }>
  | Readonly<{ status: "conflict" }>
  | Readonly<{ status: "invalid" }>;

// Adding a section either lands (returning the Work opened at the new section) or is refused as stale.
export type WorkEditorAddResult<W extends WorkEditorWork> =
  | Readonly<{ status: "added"; work: W }>
  | Readonly<{ status: "conflict" }>;

// The origin-specific data access the editor drives, injected by the page so the editor stays neutral to
// whether it is editing an owner's manual Work or correcting shared imported content.
export type WorkEditorApi<W extends WorkEditorWork> = Readonly<{
  addSection: (workEntryId: string, revision: number) => Promise<WorkEditorAddResult<W>>;
  fetchUnit: (
    workEntryId: string,
    unitEntryId: string
  ) => Promise<Readonly<{ document: DocumentNodeJSON }>>;
  fetchWork: (workEntryId: string) => Promise<W>;
  saveContent: (
    workEntryId: string,
    unitEntryId: string,
    document: DocumentNodeJSON,
    revision: number
  ) => Promise<WorkEditorSaveResult<W>>;
}>;

// The outcome of a canonical save, used both by the Save action and by navigation/add (which only proceed
// after a clean save). `busy` is a save attempted while one is already in flight.
type SaveOutcome = "saved" | "conflict" | "invalid" | "error" | "busy";

// Warn before the browser unloads while edits the server has not confirmed would be lost, so an explicit
// save the learner has not made yet is never discarded silently on reload/close.
export function useUnsavedGuard(active: boolean): void {
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

// The editor shell: a Library parent link, the work title, an optional leading action (e.g. "Open in
// Reader" for a correction), the save status + Save action, and the workspace. Shared by the page-level
// loading/error arms so every state uses the same calm frame.
export function EditorFrame({
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

export function WorkContentEditor<W extends WorkEditorWork>({
  api,
  evidence,
  leadingAction,
  onContentSaved,
  work: initialWork
}: Readonly<{
  api: WorkEditorApi<W>;
  // Optional PDF extraction evidence keyed by block id (#763), passed straight to the shared editor's
  // evidence seam. The imported-correction page supplies it; the manual editor omits it, so nothing shows.
  evidence?: ExtractionEvidenceMap;
  // An optional action rendered before the Save control (e.g. "Open in Reader" for a correction).
  leadingAction?: React.ReactNode;
  // Called after every successful save so a consumer can refetch derived state — the correction page
  // refetches extraction evidence so a just-corrected block's cue clears (#763).
  onContentSaved?: () => void;
  work: W;
}>): React.JSX.Element {
  const [work, setWork] = useState<W>(initialWork);
  const [activeUnitEntryId, setActiveUnitEntryId] = useState<string>(initialWork.unitEntryId);
  // Normalize the loaded document into the editor's own canonical shape up front. A manual Work's stored
  // document was authored BY this editor and is already canonical, but a canonical imported Work's blocks
  // were built by the ingestion pipeline, so the editor's mount echo re-serializes them into a shape that
  // differs only in JSON form (default attrs / key order). Comparing that echo against the raw stored
  // document would read "Unsaved changes" the instant a correction opens. Seeding the baseline with the
  // editor-canonical form makes the mount echo match, so opening an imported Work reads "Saved" until a
  // real edit lands. `editorDocumentsEqualIgnoringIds` still ignores generated ids on top of this.
  const [draft, setDraft] = useState<DocumentNodeJSON>(() =>
    validateEditorDocument(initialWork.document)
  );
  // The last document the server confirmed for the ACTIVE section. `dirty` is derived against it, so the
  // status is truthful even after an undo back to the saved content; it is also the editor's `document`
  // prop, so adopting the server's canonical (possibly normalized) document after a save re-syncs the
  // visible editor.
  const [savedDocument, setSavedDocument] = useState<DocumentNodeJSON>(() =>
    validateEditorDocument(initialWork.document)
  );
  const [status, setStatus] = useState<WorkEditorSaveStatus>("saved");
  const [addPending, setAddPending] = useState(false);
  // Bumped to a number to focus the active section's heading after a user-driven open (selection/add);
  // `undefined` on first load so opening the work does not steal focus into the editor.
  const [focusSignal, setFocusSignal] = useState<number | undefined>(undefined);

  // A single in-flight save at a time: a rapid second Save/Ctrl+S while one is pending is ignored rather
  // than racing two writes.
  const savingRef = useRef(false);
  // Async navigation/add read the latest values through refs so their awaited continuations never act on
  // a stale render snapshot (the shared editor also re-emits an onChange on mount).
  const workRef = useRef(work);
  const activeUnitRef = useRef(activeUnitEntryId);
  const draftRef = useRef(draft);
  const savedDocumentRef = useRef(savedDocument);
  useEffect(() => {
    workRef.current = work;
  }, [work]);
  useEffect(() => {
    activeUnitRef.current = activeUnitEntryId;
  }, [activeUnitEntryId]);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    savedDocumentRef.current = savedDocument;
  }, [savedDocument]);

  // Compare ignoring per-block ids: the editor stamps an id onto a freshly created section's `id: null`
  // nodes, and a save may return server-assigned ids, so only a real content change is "unsaved".
  const dirty = !editorDocumentsEqualIgnoringIds(draft, savedDocument);
  useUnsavedGuard(dirty || status === "saving" || status === "conflict" || status === "error");

  // The Outline reflects the active section's live DRAFT (headings appear/rename immediately) layered over
  // the persisted sections; a save then replaces the projection with the server-reconciled canonical
  // Outline. While saving/conflicted/errored the projection stays visible under the page's status.
  const outlineEntries = useMemo(
    () => projectDraftOutline(work.sections, activeUnitEntryId, draft),
    [work.sections, activeUnitEntryId, draft]
  );

  const bumpFocus = useCallback((): void => {
    setFocusSignal((previous) => (previous === undefined ? 1 : previous + 1));
  }, []);

  const handleChange = useCallback((document: DocumentNodeJSON): void => {
    setDraft(document);
    draftRef.current = document;
    // The editor's mount echo re-emits the loaded document with generated ids; only a real divergence
    // from the saved baseline is an unsaved edit, so opening a section reads "Saved" rather than
    // "Unsaved changes".
    setStatus((previous) =>
      previous === "saving"
        ? previous
        : editorDocumentsEqualIgnoringIds(document, savedDocumentRef.current)
          ? "saved"
          : "unsaved"
    );
  }, []);

  // Save the active section's document with the work-level revision. Updates the section list and
  // revision on success; keeps the local edits on every refusal so nothing the learner typed is lost.
  const runSave = useCallback(
    async (document: DocumentNodeJSON): Promise<SaveOutcome> => {
      if (savingRef.current) {
        return "busy";
      }

      savingRef.current = true;
      setDraft(document);
      draftRef.current = document;
      setStatus("saving");

      let result;
      try {
        result = await api.saveContent(
          workRef.current.entryId,
          activeUnitRef.current,
          document,
          workRef.current.revision
        );
      } catch {
        savingRef.current = false;
        setStatus("error");
        return "error";
      }

      if (result.status === "saved") {
        // Adopt the server's canonical document as the new local baseline AND editor content, the recomputed
        // section list/revision so the Outline refreshes, and the ACTIVE unit the server reconciled to — a
        // repartition can move the edited blocks into a different unit (e.g. a merge deletes the edited unit),
        // so focus follows the server's active section rather than a now-stale id (#698).
        setWork(result.work);
        workRef.current = result.work;
        activeUnitRef.current = result.work.unitEntryId;
        savedDocumentRef.current = result.work.document;
        draftRef.current = result.work.document;
        setActiveUnitEntryId(result.work.unitEntryId);
        setSavedDocument(result.work.document);
        setDraft(result.work.document);
        setStatus("saved");
        savingRef.current = false;
        onContentSaved?.();
        return "saved";
      }

      // A malformed document the server refused (defensive). Keep the local edits so the learner can adjust
      // and retry rather than losing them.
      if (result.status === "invalid") {
        setStatus("validation-error");
        savingRef.current = false;
        return "invalid";
      }

      // A stale revision: another session wrote in between. Keep the learner's local edits and adopt the
      // current revision/sections, so pressing Save again deliberately overwrites the newer version.
      let latest;
      try {
        latest = await api.fetchWork(workRef.current.entryId);
      } catch {
        savingRef.current = false;
        setStatus("error");
        return "error";
      }

      setWork((previous) => {
        const adopted = { ...previous, revision: latest.revision, sections: latest.sections };
        workRef.current = adopted;
        return adopted;
      });
      setStatus("conflict");
      savingRef.current = false;
      return "conflict";
    },
    [api, onContentSaved]
  );

  // Open a section. Saves the current section first (save-before-switch); a failure/conflict leaves the
  // current draft, section, and active item unchanged. On a clean save (or no pending edits) it loads the
  // target section's document and focuses its heading.
  const navigateTo = useCallback(
    async (unitEntryId: string): Promise<void> => {
      if (unitEntryId === activeUnitRef.current || savingRef.current || addPending) {
        return;
      }

      const isDirty = !editorDocumentsEqualIgnoringIds(draftRef.current, savedDocumentRef.current);
      if (isDirty) {
        const outcome = await runSave(draftRef.current);
        if (outcome !== "saved") {
          return;
        }
      }

      let unit;
      try {
        unit = await api.fetchUnit(workRef.current.entryId, unitEntryId);
      } catch {
        setStatus("error");
        return;
      }

      activeUnitRef.current = unitEntryId;
      // Canonicalize the freshly loaded section for the same reason as the initial load: a pipeline-built
      // imported section must match the editor's mount echo so switching to it reads "Saved", not dirty.
      const openedDocument = validateEditorDocument(unit.document);
      savedDocumentRef.current = openedDocument;
      draftRef.current = openedDocument;
      setActiveUnitEntryId(unitEntryId);
      setSavedDocument(openedDocument);
      setDraft(openedDocument);
      setStatus("saved");
      bumpFocus();
    },
    [addPending, api, bumpFocus, runSave]
  );

  // Append a new heading-led section and open it. Saves the current section first (a failure/conflict
  // aborts the add and leaves everything unchanged), then focuses the new section's empty heading so the
  // learner names it.
  const addSection = useCallback(async (): Promise<void> => {
    if (savingRef.current) {
      return;
    }

    const isDirty = !editorDocumentsEqualIgnoringIds(draftRef.current, savedDocumentRef.current);
    if (isDirty) {
      const outcome = await runSave(draftRef.current);
      if (outcome !== "saved") {
        return;
      }
    }

    setAddPending(true);
    let result;
    try {
      result = await api.addSection(workRef.current.entryId, workRef.current.revision);
    } catch {
      setAddPending(false);
      setStatus("error");
      return;
    }

    if (result.status === "conflict") {
      // Another session wrote in between: adopt the current revision/sections and keep the learner where
      // they are, so a repeat add works against the latest state.
      try {
        const latest = await api.fetchWork(workRef.current.entryId);
        setWork((previous) => {
          const adopted = { ...previous, revision: latest.revision, sections: latest.sections };
          workRef.current = adopted;
          return adopted;
        });
        setStatus("conflict");
      } catch {
        setStatus("error");
      }
      setAddPending(false);
      return;
    }

    setWork(result.work);
    workRef.current = result.work;
    activeUnitRef.current = result.work.unitEntryId;
    savedDocumentRef.current = result.work.document;
    draftRef.current = result.work.document;
    setActiveUnitEntryId(result.work.unitEntryId);
    setSavedDocument(result.work.document);
    setDraft(result.work.document);
    setStatus("saved");
    setAddPending(false);
    bumpFocus();
  }, [api, bumpFocus, runSave]);

  const header = (
    <div className="flex items-center gap-3">
      {leadingAction}
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
          void runSave(draft);
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
      <div className="manualWorkWorkspace">
        <WorkOutline
          activeUnitEntryId={activeUnitEntryId}
          addPending={addPending}
          entries={outlineEntries}
          onAddSection={() => {
            void addSection();
          }}
          onSelect={(unitEntryId) => {
            void navigateTo(unitEntryId);
          }}
        />
        <div className="manualWorkCanvas">
          <RichContentEditor
            ariaLabel={`Edit ${work.title}`}
            document={savedDocument}
            {...(evidence ? { evidence } : {})}
            focusSignal={focusSignal}
            key={activeUnitEntryId}
            onChange={handleChange}
            onSave={(document) => {
              void runSave(document);
            }}
            presentation="full"
            showToolbar
          />
        </div>
      </div>
    </EditorFrame>
  );
}
