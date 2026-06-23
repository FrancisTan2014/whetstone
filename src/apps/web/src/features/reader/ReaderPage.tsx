import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteTemplateDto, WorkListItemDto } from "@whetstone/contracts";

import { NoteEditor } from "../notes/NoteEditor";
import { captureBlockSelection, type NoteDraft } from "../notes/noteCapture";
import { fetchNoteTemplates } from "../notes/notesApi";
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { buildReaderView, type ReaderBlock, type ReaderUnit, type ReaderView } from "./readerModel";

// remark-gfm mirrors the ingestion parser; rehype-sanitize strips unsafe HTML so
// the reader never executes raw markup (no dangerouslySetInnerHTML).
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

type SelectBlock = (block: ReaderBlock, workEntryId: string) => void;

type PendingNote = Readonly<{ draft: NoteDraft; workEntryId: string }>;

type ReadingState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; workEntryId: string }>
  | Readonly<{ status: "error"; workEntryId: string }>
  | Readonly<{ status: "viewing"; view: ReaderView; workEntryId: string }>;

type ReaderState =
  | Readonly<{ status: "loadingWorks" }>
  | Readonly<{ status: "worksError" }>
  | Readonly<{ reading: ReadingState; status: "ready"; works: ReadonlyArray<WorkListItemDto> }>;

export function ReaderPage(): React.JSX.Element {
  const [state, setState] = useState<ReaderState>({ status: "loadingWorks" });
  const [templates, setTemplates] = useState<ReadonlyArray<NoteTemplateDto>>([]);
  const [pendingNote, setPendingNote] = useState<PendingNote | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);

  useEffect(() => {
    fetchWorks()
      .then((list) => setState({ reading: { status: "idle" }, status: "ready", works: list.works }))
      .catch(() => setState({ status: "worksError" }));
  }, []);

  useEffect(() => {
    fetchNoteTemplates()
      .then((list) => setTemplates(list.templates))
      .catch(() => setTemplates([]));
  }, []);

  async function openWork(
    works: ReadonlyArray<WorkListItemDto>,
    workEntryId: string
  ): Promise<void> {
    setState({ reading: { status: "loading", workEntryId }, status: "ready", works });

    try {
      const content = await fetchWorkContent(workEntryId);

      setState({
        reading: { status: "viewing", view: buildReaderView(content), workEntryId },
        status: "ready",
        works
      });
    } catch {
      setState({ reading: { status: "error", workEntryId }, status: "ready", works });
    }
  }

  function onSelectBlock(block: ReaderBlock, workEntryId: string): void {
    const selection = window.getSelection();
    const selectedText = selection === null ? "" : selection.toString();
    const draft = captureBlockSelection(block.entryId, block.plaintext, selectedText);

    if (draft !== undefined) {
      setNotice(undefined);
      setPendingNote({ draft, workEntryId });
    }
  }

  return (
    <section aria-labelledby="reader-heading" className="readerShell">
      <h1 id="reader-heading">Reader</h1>

      {state.status === "loadingWorks" ? <p>Loading works…</p> : null}
      {state.status === "worksError" ? <p role="alert">Could not load works.</p> : null}

      {state.status === "ready"
        ? renderReady(
            state.works,
            state.reading,
            (workEntryId) => void openWork(state.works, workEntryId),
            onSelectBlock
          )
        : null}

      {notice === undefined ? null : (
        <p className="readerNotice" role="status">
          {notice}
        </p>
      )}

      {pendingNote === undefined ? null : (
        <NoteEditor
          draft={pendingNote.draft}
          onClose={() => setPendingNote(undefined)}
          onSaved={() => {
            setPendingNote(undefined);
            setNotice("Note saved.");
          }}
          templates={templates}
          workEntryId={pendingNote.workEntryId}
        />
      )}
    </section>
  );
}

function renderReady(
  works: ReadonlyArray<WorkListItemDto>,
  reading: ReadingState,
  onOpen: (workEntryId: string) => void,
  onSelectBlock: SelectBlock
): React.JSX.Element {
  if (works.length === 0) {
    return <p>No works yet. Create one in the library admin.</p>;
  }

  const openWorkEntryId = reading.status === "idle" ? undefined : reading.workEntryId;

  return (
    <div className="readerLayout">
      <nav aria-label="Works">
        <ul className="readerWorkList">
          {works.map((item) => (
            <li key={item.work.entryId}>
              <button
                aria-pressed={item.work.entryId === openWorkEntryId}
                onClick={() => onOpen(item.work.entryId)}
                type="button"
              >
                {item.work.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {renderReading(reading, onSelectBlock)}
    </div>
  );
}

function renderReading(reading: ReadingState, onSelectBlock: SelectBlock): React.JSX.Element {
  switch (reading.status) {
    case "idle":
      return <p className="readerHint">Select a work to start reading.</p>;
    case "loading":
      return <p>Loading the work…</p>;
    case "error":
      return <p role="alert">Could not load this work. Please try again.</p>;
    case "viewing":
      return renderReaderView(reading.view, onSelectBlock);
  }
}

function renderReaderView(view: ReaderView, onSelectBlock: SelectBlock): React.JSX.Element {
  if (view.units.length === 0) {
    return <p>This work has no content yet.</p>;
  }

  return (
    <article aria-label="Reading" className="reader">
      {view.units.map((unit) => renderUnit(unit, view.workEntryId, onSelectBlock))}
    </article>
  );
}

function renderUnit(
  unit: ReaderUnit,
  workEntryId: string,
  onSelectBlock: SelectBlock
): React.JSX.Element {
  return (
    <section className="readerUnit" key={unit.entryId}>
      {unit.title === undefined ? null : <h2 className="readerUnitTitle">{unit.title}</h2>}
      {unit.blocks.map((block) => (
        <div
          className="readerBlock"
          data-block-id={block.entryId}
          key={block.entryId}
          onMouseUp={() => onSelectBlock(block, workEntryId)}
        >
          <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
            {block.markdown}
          </Markdown>
        </div>
      ))}
    </section>
  );
}
