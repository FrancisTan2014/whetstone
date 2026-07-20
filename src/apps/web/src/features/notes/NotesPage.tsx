import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type {
  DirectCardResultDto,
  ImportNotesResultDto,
  NoteOverviewDto
} from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { PageFrame } from "../../shared/ui/PageFrame";
import { useLearnerTimeZone } from "../../shared/preferences/useLearnerTimeZone";
import { DirectCardComposer } from "./DirectCardComposer";
import { fetchAllNotes } from "./notesApi";
import { NotesHomeList } from "./NotesHomeList";
import { NotesImport } from "./NotesImport";
import { OwnedNoteEditor } from "./OwnedNoteEditor";

type NotesState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ notes: ReadonlyArray<NoteOverviewDto>; status: "ready" }>;

// The Notes home (#659, PRODUCT.md "Notes"): the single place every owned note lives — anchored, standalone,
// imported, or a Mark — as one continuous list in the server's recency order (never grouped by work). A
// note-centric search narrows the list across body, source snapshot, prompt questions, and legacy answers;
// clearing it restores the full list. The one primary "New card" action composes a recurring review card
// directly from an authored Question/Answer pair (#690) — notes are never created blank here; they arrive
// from Reader capture, direct card creation, or Import. Opening any existing note edits it in the shared
// rich editor (with its owner-scoped Review controls and a named-delete cascade). When `focusWorkEntryId`
// is set (the Library's contextual "Notes" action passes `#/notes?work=<id>`), the list narrows to that one
// work without changing the order.
type NotesPageProps = Readonly<{ focusWorkEntryId?: string | undefined }>;

export function NotesPage({ focusWorkEntryId }: NotesPageProps): React.JSX.Element {
  const navigate = useNavigate();
  const [state, setState] = useState<NotesState>({ status: "loading" });
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  // The learner's persisted zone (#676): every Notes-home row resolves its next-review label in it.
  const timeZone = useLearnerTimeZone();
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editNote, setEditNote] = useState<NoteOverviewDto | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [cardMessage, setCardMessage] = useState<string | null>(null);
  // The note a just-created card reviews: retained so its row can be focused once the reloaded list
  // settles, or — when an active search or work filter would exclude it — a "View card" affordance can
  // clear the filter and reveal it.
  const [viewCardEntryId, setViewCardEntryId] = useState<string | undefined>(undefined);
  const [focusEntryId, setFocusEntryId] = useState<string | undefined>(undefined);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  const newCardRef = useRef<HTMLButtonElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  // After an import lands, move focus to the first imported note's Open button once the reloaded list has
  // settled. A ref, not state, so arming it never re-renders and it survives the reload it triggers.
  const pendingImportFocus = useRef(false);
  // After a created card's list settles, focus its note's row, or the primary "New card" action when a
  // filter excludes it. A ref, not state, so arming it never re-renders and it survives the reload.
  const pendingCardFocus = useRef(false);
  // The created card's note entry id, mirrored in a ref so the settle effect reads the latest value
  // without re-firing against the pre-reload list when the id changes.
  const cardFocusId = useRef<string | undefined>(undefined);
  // After a cancelled import, return focus to the Import button — but only once the panel has closed and
  // the button is enabled again, so a synchronous focus on the still-disabled button never silently fails.
  const pendingImportButtonFocus = useRef(false);
  // Where to return focus after the editor closes: the row's Open button when the note is still present,
  // or the primary "New card" action when it is not (a deleted note). A ref, not state, so setting it
  // never re-renders and it survives the reload triggered alongside the close.
  const pendingFocus = useRef<"new" | "row" | null>(null);

  // Debounce the search box so typing does not fire a request per keystroke; the trimmed value drives the
  // fetch. A blank box restores the full list (no `search` param). The transition happens in the timer
  // callback, never synchronously in the effect body.
  useEffect(() => {
    const handle = setTimeout(() => setQuery(input.trim()), 200);
    return () => clearTimeout(handle);
  }, [input]);

  // The single fetch: (re)load the list whenever the search term, the work filter, or a mutation nonce
  // changes. On a reload the previous notes stay on screen until the new ones arrive (no full-page reset);
  // only the very first load shows the loading state. State moves happen in the promise callbacks.
  useEffect(() => {
    let active = true;
    fetchAllNotes({
      search: query === "" ? undefined : query,
      workEntryId: focusWorkEntryId
    }).then(
      (response) => {
        if (active) {
          setState({ notes: response.notes, status: "ready" });
        }
      },
      () => {
        if (active) {
          setState({ status: "error" });
        }
      }
    );
    return () => {
      active = false;
    };
  }, [query, focusWorkEntryId, reloadNonce]);

  // After the editor closes, return focus to the control the learner came from, once the list has settled.
  useEffect(() => {
    if (editNote !== null) {
      return;
    }
    const target = pendingFocus.current;
    if (target === null) {
      return;
    }
    pendingFocus.current = null;
    if (target === "new") {
      newCardRef.current?.focus();
    } else {
      openButtonRef.current?.focus();
    }
  }, [editNote]);

  // Once a created card's reloaded list settles, focus its note's row when present, or the primary "New
  // card" action when a search or work filter excludes the new standalone note — and, in that case, offer
  // a "View card" affordance that clears the filter to reveal it.
  useEffect(() => {
    if (!pendingCardFocus.current || state.status !== "ready") {
      return;
    }
    pendingCardFocus.current = false;
    const present = state.notes.some((note) => note.entryId === cardFocusId.current);
    if (present) {
      setViewCardEntryId(undefined);
      openButtonRef.current?.focus();
    } else {
      setViewCardEntryId(cardFocusId.current);
      newCardRef.current?.focus();
    }
  }, [state]);

  // Once an import's reloaded list has settled, move focus to the first imported note's Open button.
  useEffect(() => {
    if (!pendingImportFocus.current || state.status !== "ready") {
      return;
    }
    pendingImportFocus.current = false;
    openButtonRef.current?.focus();
  }, [state]);

  // Once a cancelled import has closed the panel and re-enabled the Import button, restore focus to it.
  useEffect(() => {
    if (importing || !pendingImportButtonFocus.current) {
      return;
    }
    pendingImportButtonFocus.current = false;
    importRef.current?.focus();
  }, [importing]);

  // Open the direct-card composer (#690): the primary Notes-home action. Clear any prior status so the
  // sheet opens clean; the Sheet restores focus to this button on close.
  function openComposer(): void {
    setImportMessage(null);
    setCardMessage(null);
    setViewCardEntryId(undefined);
    setComposerOpen(true);
  }

  function onCardCreated(result: DirectCardResultDto): void {
    setComposerOpen(false);
    setCardMessage("Card created. Due now.");
    cardFocusId.current = result.noteId;
    setFocusEntryId(result.noteId);
    pendingCardFocus.current = true;
    setReloadNonce((nonce) => nonce + 1);
  }

  // Reveal a created card's note that the active filter excluded: clear the search and drop any work
  // filter, then re-arm the row focus so the note lands focused once the unfiltered list settles.
  function viewCard(): void {
    setViewCardEntryId(undefined);
    setInput("");
    setQuery("");
    navigate("/notes");
    setFocusEntryId(cardFocusId.current);
    pendingCardFocus.current = true;
  }

  function openEdit(note: NoteOverviewDto): void {
    setFocusEntryId(note.entryId);
    pendingFocus.current = "row";
    setEditNote(note);
  }

  function requestClose(): void {
    setEditNote(null);
  }

  function onSaved(): void {
    setEditNote(null);
    setReloadNonce((nonce) => nonce + 1);
  }

  function onDeleted(): void {
    pendingFocus.current = "new";
    setEditNote(null);
    setReloadNonce((nonce) => nonce + 1);
  }

  function onReviewChanged(): void {
    setReloadNonce((nonce) => nonce + 1);
  }

  function openImport(): void {
    setImportMessage(null);
    setImporting(true);
  }

  function onImportCancelled(): void {
    setImporting(false);
    pendingImportButtonFocus.current = true;
  }

  function onImported(result: ImportNotesResultDto): void {
    setImporting(false);
    const count = result.imported.length;
    setImportMessage(count === 1 ? "Imported 1 note." : `Imported ${count} notes.`);
    const first = result.imported[0]?.noteEntryId;
    if (first !== undefined) {
      setFocusEntryId(first);
      pendingImportFocus.current = true;
    }
    setReloadNonce((nonce) => nonce + 1);
  }

  return (
    <PageFrame
      description={
        focusWorkEntryId === undefined
          ? "Every note you have saved, in one place."
          : "Every note you have saved in this work."
      }
      primaryAction={
        <Button
          disabled={importing || composerOpen}
          onClick={openComposer}
          ref={newCardRef}
          type="button"
        >
          New card
        </Button>
      }
      title="Notes"
    >
      <div>
        {cardMessage !== null ? (
          <div aria-live="polite" className="flex flex-wrap items-center gap-2" role="status">
            <span className="text-sm text-success">{cardMessage}</span>
            {viewCardEntryId !== undefined ? (
              <Button onClick={viewCard} type="button" variant="ghost">
                View card
              </Button>
            ) : null}
          </div>
        ) : null}

        {importMessage !== null ? (
          <p aria-live="polite" className="text-sm text-success" role="status">
            {importMessage}
          </p>
        ) : null}

        {importing ? (
          <div className="mt-6">
            <NotesImport onCancel={onImportCancelled} onImported={onImported} />
          </div>
        ) : (
          <>
            {/* Import is a secondary affordance, so it sits in the page body rather than the header —
                the header keeps a single persistent primary action (New card), per #641/#690. */}
            <div className="mt-4 flex justify-end">
              <Button onClick={openImport} ref={importRef} type="button" variant="ghost">
                Import
              </Button>
            </div>

            <label className="mt-4 block">
              <span className="sr-only">Search notes</span>
              <input
                aria-label="Search notes"
                className="min-h-11 w-full rounded border border-border bg-surface px-3 text-text focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onChange={(event) => setInput(event.target.value)}
                placeholder="Search your notes"
                type="search"
                value={input}
              />
            </label>

            <div aria-busy={state.status === "loading"} className="mt-6">
              {renderState(state, query, focusWorkEntryId, timeZone, {
                onOpen: openEdit,
                openRef: openButtonRef,
                openTargetEntryId: focusEntryId
              })}
            </div>
          </>
        )}

        {editNote !== null ? (
          <OwnedNoteEditor
            key={editNote.entryId}
            onClose={requestClose}
            onDeleted={onDeleted}
            onReviewChanged={onReviewChanged}
            onSaved={onSaved}
            target={{ kind: "edit", note: editNote }}
          />
        ) : null}

        {composerOpen ? (
          <DirectCardComposer onClose={() => setComposerOpen(false)} onCreated={onCardCreated} />
        ) : null}
      </div>
    </PageFrame>
  );
}

type ListHandlers = Readonly<{
  onOpen: (note: NoteOverviewDto) => void;
  openRef: React.Ref<HTMLButtonElement>;
  openTargetEntryId: string | undefined;
}>;

function renderState(
  state: NotesState,
  query: string,
  focusWorkEntryId: string | undefined,
  timeZone: string,
  handlers: ListHandlers
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Loading your notes…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load your notes. Please try again.
      </p>
    );
  }

  if (state.notes.length === 0) {
    if (query !== "") {
      return <p className="text-text-muted">No notes match “{query}”.</p>;
    }
    return (
      <p className="text-text-muted">
        {focusWorkEntryId === undefined
          ? "No notes yet. Notes appear from Reader capture, a new card, or Import."
          : "No notes yet for this work. Open it in the Reader and select text to create one."}
      </p>
    );
  }

  return (
    <NotesHomeList
      notes={state.notes}
      onOpen={handlers.onOpen}
      openRef={handlers.openRef}
      openTargetEntryId={handlers.openTargetEntryId}
      timeZone={timeZone}
    />
  );
}
