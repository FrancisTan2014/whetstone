import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteOverviewDto } from "@whetstone/contracts";

import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchAllNotes } from "./notesApi";
import { groupNotesByWork, type WorkNotes } from "./groupNotesByWork";

// remark-gfm mirrors the ingestion parser; rehype-sanitize strips unsafe HTML so a rendered note
// body never executes raw markup (same safety contract as the reader's NoteList).
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

type NotesState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ groups: ReadonlyArray<WorkNotes>; status: "ready" }>;

// Cross-work Notes mode (PRODUCT.md "Notes" mode): lists every saved note grouped by work, each
// linking back to its anchored block in the Reader (`#/reader?work=&block=`). Read-only here;
// editing/deleting still happens inside the Reader's note panel.
export function NotesPage(): React.JSX.Element {
  const [state, setState] = useState<NotesState>({ status: "loading" });

  useEffect(() => {
    fetchAllNotes()
      .then((response) => setState({ groups: groupNotesByWork(response.notes), status: "ready" }))
      .catch(() => setState({ status: "error" }));
  }, []);

  return (
    <section aria-labelledby="notes-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="notes-heading">
        Notes
      </h1>
      <p className="mt-2 text-text-muted">Every note you have saved, across all works.</p>

      <div className="mt-6">{renderState(state)}</div>
    </section>
  );
}

function renderState(state: NotesState): React.JSX.Element {
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

  if (state.groups.length === 0) {
    return (
      <p className="text-text-muted">
        No notes yet. Open a work in the Reader and select text to create one.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {state.groups.map((group) => (
        <section aria-labelledby={`notes-work-${group.workEntryId}`} key={group.workEntryId}>
          <h2
            className="mb-3 text-xl font-semibold text-text"
            id={`notes-work-${group.workEntryId}`}
          >
            {group.workTitle}
            <span className="ml-2 text-sm font-normal text-text-muted">{group.authorName}</span>
          </h2>
          <ul aria-label={`Notes in ${group.workTitle}`} className="flex flex-col gap-3">
            {group.notes.map((note) => renderNote(note))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function renderNote(note: NoteOverviewDto): React.JSX.Element {
  return (
    <li className="rounded border border-border bg-surface p-4" key={note.entryId}>
      <p className="text-sm text-text-muted">“{note.anchor.selectedTextSnapshot}”</p>
      <div className="mt-2 text-text">
        <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
          {note.markdown}
        </Markdown>
      </div>
      <a
        className="mt-3 inline-block text-sm text-accent hover:text-accent-hover"
        href={`#/reader?work=${encodeURIComponent(note.workEntryId)}&block=${encodeURIComponent(
          note.blockEntryId
        )}`}
      >
        Open in Reader
      </a>
    </li>
  );
}
