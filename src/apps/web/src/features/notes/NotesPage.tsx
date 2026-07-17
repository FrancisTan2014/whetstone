import { useEffect, useRef, useState } from "react";

import type { NoteOverviewDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchAllNotes } from "./notesApi";
import { NotesHomeList } from "./NotesHomeList";
import { OwnedNoteEditor, type OwnedNoteEditorTarget } from "./OwnedNoteEditor";

type NotesState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ notes: ReadonlyArray<NoteOverviewDto>; status: "ready" }>;

// The Notes home (#659, PRODUCT.md "Notes"): the single place every owned note lives — anchored, standalone,
// imported, or a Mark — as one continuous list in the server's recency order (never grouped by work). A
// note-centric search narrows the list across body, source snapshot, prompt questions, and legacy answers;
// clearing it restores the full list. One primary "New note" action creates a standalone note, and opening
// any note edits it in the shared rich editor (with its owner-scoped Review controls and a named-delete
// cascade). When `focusWorkEntryId` is set (the Library's contextual "Notes" action passes
// `#/notes?work=<id>`), the list narrows to that one work without changing the order.
type NotesPageProps = Readonly<{ focusWorkEntryId?: string | undefined }>;

export function NotesPage({ focusWorkEntryId }: NotesPageProps): React.JSX.Element {
  const [state, setState] = useState<NotesState>({ status: "loading" });
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [editor, setEditor] = useState<OwnedNoteEditorTarget | null>(null);
  const [focusEntryId, setFocusEntryId] = useState<string | undefined>(undefined);

  const newNoteRef = useRef<HTMLButtonElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  // Where to return focus after the editor closes: the row's Open button when the note is still present,
  // or the primary "New note" action when it is not (a fresh create, or a deleted note). A ref, not state,
  // so setting it never re-renders and it survives the reload triggered alongside the close.
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
    if (editor !== null) {
      return;
    }
    const target = pendingFocus.current;
    if (target === null) {
      return;
    }
    pendingFocus.current = null;
    if (target === "new") {
      newNoteRef.current?.focus();
    } else {
      openButtonRef.current?.focus();
    }
  }, [editor]);

  function openCreate(): void {
    setEditor({ kind: "create" });
  }

  function openEdit(note: NoteOverviewDto): void {
    setFocusEntryId(note.entryId);
    setEditor({ kind: "edit", note });
  }

  function requestClose(): void {
    pendingFocus.current = editor?.kind === "edit" ? "row" : "new";
    setEditor(null);
  }

  function onSaved(): void {
    pendingFocus.current = editor?.kind === "edit" ? "row" : "new";
    setEditor(null);
    setReloadNonce((nonce) => nonce + 1);
  }

  function onDeleted(): void {
    pendingFocus.current = "new";
    setEditor(null);
    setReloadNonce((nonce) => nonce + 1);
  }

  return (
    <section aria-labelledby="notes-heading" className="mx-auto max-w-2xl p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold text-text" id="notes-heading">
          Notes
        </h1>
        <Button onClick={openCreate} ref={newNoteRef} type="button">
          New note
        </Button>
      </div>

      <p className="mt-2 text-text-muted">
        {focusWorkEntryId === undefined
          ? "Every note you have saved, in one place."
          : "Every note you have saved in this work."}
      </p>

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
        {renderState(state, query, focusWorkEntryId, {
          onOpen: openEdit,
          openRef: openButtonRef,
          openTargetEntryId: focusEntryId
        })}
      </div>

      {editor !== null ? (
        <OwnedNoteEditor
          key={editor.kind === "edit" ? editor.note.entryId : "create"}
          onClose={requestClose}
          onDeleted={onDeleted}
          onSaved={onSaved}
          target={editor}
        />
      ) : null}
    </section>
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
          ? "No notes yet. Create one with “New note”, or select text in the Reader."
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
    />
  );
}
