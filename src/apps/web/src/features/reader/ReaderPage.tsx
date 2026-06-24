import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Markdown, { type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteDto, NoteTemplateDto, WorkListItemDto } from "@whetstone/contracts";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion";
import { Toast } from "../../shared/ui/Toast";
import { NoteEditor } from "../notes/NoteEditor";
import { NoteList } from "../notes/NoteList";
import { captureBlockSelection, type NoteDraft } from "../notes/noteCapture";
import { deleteNote, fetchNoteTemplates, fetchNotes } from "../notes/notesApi";
import { SelectionToolbar } from "../notes/SelectionToolbar";
import { annotationHueClass } from "./annotationHue";
import { LookupPanel, type LookupState } from "../lookup/LookupPanel";
import { lookupTerm } from "../lookup/lookupApi";
import { readBlockSelection } from "./blockSelection";
import { highlightBirthMotion } from "./highlightBirth";
import { fetchWorkContent, fetchWorks } from "./readerApi";
import { buildReaderView, type ReaderBlock, type ReaderUnit, type ReaderView } from "./readerModel";
import { ReadingHeader } from "./ReadingHeader";
import { defaultReadingSize, readingSizeToRem, type ReadingSize } from "./readingSize";
import { scrollToBlock } from "./scrollToBlock";
import { selectionRect } from "./selectionRect";
import { useReaderScroll, type ReaderScroll } from "./useReaderScroll";

// remark-gfm mirrors the ingestion parser; rehype-sanitize strips unsafe HTML so
// the reader never executes raw markup (no dangerouslySetInnerHTML). We further disallow
// `img` (v0 is text blocks only) so no external image is ever fetched or rendered, even
// from manually entered Markdown.
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames as string[]).filter((tagName) => tagName !== "img")
};
const remarkPlugins = [remarkGfm];
const rehypePlugins: NonNullable<Options["rehypePlugins"]> = [[rehypeSanitize, sanitizeSchema]];

// Immersive-reader chrome state shared with the reading view: the language-aware paper
// surface, the text-size control, the auto-hiding header, and the entrance motion.
type ReaderChrome = Readonly<{
  language: string;
  onSizeChange: (size: ReadingSize) => void;
  prefersReducedMotion: boolean;
  scroll: ReaderScroll;
  size: ReadingSize;
  title: string;
}>;

type ReadingState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; workEntryId: string }>
  | Readonly<{ status: "error"; workEntryId: string }>
  | Readonly<{ status: "viewing"; view: ReaderView; workEntryId: string }>;

type ReaderState =
  | Readonly<{ status: "loadingWorks" }>
  | Readonly<{ status: "worksError" }>
  | Readonly<{ reading: ReadingState; status: "ready"; works: ReadonlyArray<WorkListItemDto> }>;

// At most one note panel is open at a time: capturing a new note, editing an existing one, or
// listing the notes anchored to a single block (reopened from its highlight).
type NotePanel =
  | Readonly<{ draft: NoteDraft; kind: "create"; workEntryId: string }>
  | Readonly<{ kind: "edit"; note: NoteDto; workEntryId: string }>
  | Readonly<{ blockEntryId: string; kind: "block"; workEntryId: string }>;

// A pending capture: a selection has been made and the floating toolbar is offering its
// size-preselected (but switchable) template before the editor opens. `anchorRect` is the
// selection's rect (for positioning), `language` is the open work's language (so a Chinese
// selection routes to CC-CEDICT), and `selectedTemplateId` tracks the toolbar choice.
type SelectionCapture = Readonly<{
  anchorRect?: DOMRect | undefined;
  draft: NoteDraft;
  language: string;
  selectedTemplateId: string;
  workEntryId: string;
}>;

type ReaderHandlers = Readonly<{
  bornBlockEntryId?: string | undefined;
  notes: ReadonlyArray<NoteDto>;
  onCaptureSelection: (
    blockElement: HTMLElement,
    block: ReaderBlock,
    workEntryId: string,
    language: string
  ) => void;
  onDeleteNote: (workEntryId: string, note: NoteDto) => void;
  onEditNote: (workEntryId: string, note: NoteDto) => void;
  onJumpToBlock: (note: NoteDto) => void;
  onOpenBlockNotes: (blockEntryId: string, workEntryId: string) => void;
  prefersReducedMotion: boolean;
  templates: ReadonlyArray<NoteTemplateDto>;
}>;

function notesForBlock(
  notes: ReadonlyArray<NoteDto>,
  blockEntryId: string
): ReadonlyArray<NoteDto> {
  return notes.filter((note) => note.blockEntryId === blockEntryId);
}

// The library "Continue reading" link routes to `#/reader?work=<entryId>`; the route reads that
// query param and passes it here so the page opens straight into the requested work on arrival.
type ReaderPageProps = Readonly<{ initialWorkEntryId?: string | undefined }>;

// A view-only vocabulary lookup driven from the selection toolbar: the selected term and
// its fetch state. Lookup never creates, pre-fills, or edits a note.
type LookupView = Readonly<{ state: LookupState; term: string }>;

export function ReaderPage({ initialWorkEntryId }: ReaderPageProps): React.JSX.Element {
  const [state, setState] = useState<ReaderState>({ status: "loadingWorks" });
  const [templates, setTemplates] = useState<ReadonlyArray<NoteTemplateDto>>([]);
  const [notes, setNotes] = useState<ReadonlyArray<NoteDto>>([]);
  const [panel, setPanel] = useState<NotePanel | undefined>(undefined);
  const [capture, setCapture] = useState<SelectionCapture | undefined>(undefined);
  const [lookup, setLookup] = useState<LookupView | undefined>(undefined);
  const [bornBlockEntryId, setBornBlockEntryId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [size, setSize] = useState<ReadingSize>(defaultReadingSize);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const scroll = useReaderScroll();

  useEffect(() => {
    setPrefersReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  useEffect(() => {
    fetchWorks()
      .then((list) => {
        const works = list.works;
        const requested =
          initialWorkEntryId === undefined
            ? undefined
            : works.find((item) => item.work.entryId === initialWorkEntryId);

        if (requested === undefined) {
          setState({ reading: { status: "idle" }, status: "ready", works });
          return;
        }

        void openWork(works, requested.work.entryId);
      })
      .catch(() => setState({ status: "worksError" }));
  }, [initialWorkEntryId]);

  useEffect(() => {
    fetchNoteTemplates()
      .then((list) => setTemplates(list.templates))
      .catch(() => setTemplates([]));
  }, []);

  async function refreshNotes(workEntryId: string): Promise<void> {
    const list = await fetchNotes(workEntryId);
    setNotes(list.notes);
  }

  async function openWork(
    works: ReadonlyArray<WorkListItemDto>,
    workEntryId: string
  ): Promise<void> {
    setState({ reading: { status: "loading", workEntryId }, status: "ready", works });
    setPanel(undefined);
    setCapture(undefined);
    setLookup(undefined);
    setBornBlockEntryId(undefined);
    setNotice(undefined);
    setNotes([]);

    try {
      const content = await fetchWorkContent(workEntryId);
      await refreshNotes(workEntryId);

      setState({
        reading: { status: "viewing", view: buildReaderView(content), workEntryId },
        status: "ready",
        works
      });
    } catch {
      setState({ reading: { status: "error", workEntryId }, status: "ready", works });
    }
  }

  function onCaptureSelection(
    blockElement: HTMLElement,
    block: ReaderBlock,
    workEntryId: string,
    language: string
  ): void {
    const selection = window.getSelection();
    const blockSelection = readBlockSelection(blockElement, selection);

    if (blockSelection === undefined) {
      return;
    }

    const draft = captureBlockSelection(
      block.entryId,
      block.plaintext,
      blockSelection.selectedText,
      blockSelection.startOffset
    );

    if (draft === undefined) {
      return;
    }

    setNotice(undefined);
    setCapture({
      anchorRect: selectionRect(selection),
      draft,
      language,
      selectedTemplateId: draft.preselectedTemplateId,
      workEntryId
    });
  }

  function confirmCapture(active: SelectionCapture): void {
    setCapture(undefined);
    setPanel({
      draft: { ...active.draft, preselectedTemplateId: active.selectedTemplateId },
      kind: "create",
      workEntryId: active.workEntryId
    });
  }

  function lookupSelection(active: SelectionCapture): void {
    const term = active.draft.selectedText;
    setCapture(undefined);
    setNotice(undefined);
    setLookup({ state: { status: "loading" }, term });

    lookupTerm(term, active.language)
      .then((response) => {
        setLookup({
          state: response.found
            ? { attribution: response.attribution, entry: response.entry, status: "loaded" }
            : { status: "empty" },
          term
        });
      })
      .catch(() => setLookup({ state: { status: "error" }, term }));
  }

  function onOpenBlockNotes(blockEntryId: string, workEntryId: string): void {
    setNotice(undefined);
    setPanel({ blockEntryId, kind: "block", workEntryId });
  }

  function onEditNote(workEntryId: string, note: NoteDto): void {
    setNotice(undefined);
    setPanel({ kind: "edit", note, workEntryId });
  }

  async function onSavedNote(workEntryId: string, note: NoteDto): Promise<void> {
    setPanel(undefined);
    setBornBlockEntryId(note.blockEntryId);
    setNotice("Note saved.");
    await refreshNotes(workEntryId);
  }

  async function onDeleteNote(workEntryId: string, note: NoteDto): Promise<void> {
    try {
      await deleteNote(workEntryId, note.entryId);
    } catch {
      setNotice("Could not delete the note. Please try again.");
      return;
    }

    setPanel(undefined);
    setNotice("Note deleted.");
    await refreshNotes(workEntryId);
  }

  const handleDelete = (workEntryId: string, note: NoteDto): void =>
    void onDeleteNote(workEntryId, note);
  const handleSaved = (workEntryId: string, note: NoteDto): void =>
    void onSavedNote(workEntryId, note);

  const handlers: ReaderHandlers = {
    bornBlockEntryId,
    notes,
    onCaptureSelection,
    onDeleteNote: handleDelete,
    onEditNote,
    onJumpToBlock: (note) => scrollToBlock(note.blockEntryId),
    onOpenBlockNotes,
    prefersReducedMotion,
    templates
  };

  return (
    <section aria-labelledby="reader-heading" className="readerShell">
      <h1 id="reader-heading">Reader</h1>

      {state.status === "loadingWorks" ? <p>Loading works…</p> : null}
      {state.status === "worksError" ? <p role="alert">Could not load works.</p> : null}

      {state.status === "ready"
        ? renderReady(
            state.works,
            state.reading,
            handlers,
            (workEntryId) => void openWork(state.works, workEntryId),
            { onSizeChange: setSize, prefersReducedMotion, scroll, size }
          )
        : null}

      {notice === undefined ? null : (
        <Toast message={notice} prefersReducedMotion={prefersReducedMotion} />
      )}

      {capture === undefined ? null : (
        <SelectionToolbar
          anchorRect={capture.anchorRect}
          onClose={() => setCapture(undefined)}
          onConfirm={() => confirmCapture(capture)}
          onLookup={() => lookupSelection(capture)}
          onSelectTemplate={(templateId) =>
            setCapture({ ...capture, selectedTemplateId: templateId })
          }
          prefersReducedMotion={prefersReducedMotion}
          selectedTemplateId={capture.selectedTemplateId}
          templates={templates}
        />
      )}

      {lookup === undefined ? null : (
        <LookupPanel
          onOpenChange={() => setLookup(undefined)}
          open={true}
          state={lookup.state}
          term={lookup.term}
        />
      )}

      {renderPanel(panel, notes, templates, {
        onClose: () => setPanel(undefined),
        onDeleteNote: handleDelete,
        onEditNote,
        onJumpToBlock: (note) => scrollToBlock(note.blockEntryId),
        onSavedNote: handleSaved
      })}
    </section>
  );
}

type ReaderChromeBase = Omit<ReaderChrome, "language" | "title">;

function renderReady(
  works: ReadonlyArray<WorkListItemDto>,
  reading: ReadingState,
  handlers: ReaderHandlers,
  onOpen: (workEntryId: string) => void,
  chromeBase: ReaderChromeBase
): React.JSX.Element {
  if (works.length === 0) {
    return <p>No works yet. Create one in the library admin.</p>;
  }

  const openWorkEntryId = reading.status === "idle" ? undefined : reading.workEntryId;
  const openWork = works.find((item) => item.work.entryId === openWorkEntryId);
  const chrome: ReaderChrome = {
    ...chromeBase,
    language: openWork?.work.language ?? "en",
    title: openWork?.work.title ?? ""
  };

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

      {renderReading(reading, handlers, chrome)}
    </div>
  );
}

function renderReading(
  reading: ReadingState,
  handlers: ReaderHandlers,
  chrome: ReaderChrome
): React.JSX.Element {
  switch (reading.status) {
    case "idle":
      return <p className="readerHint">Select a work to start reading.</p>;
    case "loading":
      return <p>Loading the work…</p>;
    case "error":
      return <p role="alert">Could not load this work. Please try again.</p>;
    case "viewing":
      return renderViewing(reading.view, reading.workEntryId, handlers, chrome);
  }
}

function renderViewing(
  view: ReaderView,
  workEntryId: string,
  handlers: ReaderHandlers,
  chrome: ReaderChrome
): React.JSX.Element {
  const entrance = withReducedMotion(motionSprings.gentle, chrome.prefersReducedMotion);

  return (
    <div className="readerReading">
      <ReadingHeader
        hidden={chrome.scroll.headerHidden}
        onSizeChange={chrome.onSizeChange}
        progress={chrome.scroll.progress}
        size={chrome.size}
        title={chrome.title}
      />
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="readerEntrance"
        initial={{ opacity: 0, y: 8 }}
        key={workEntryId}
        transition={entrance}
      >
        <div
          className="reading-surface readerPaper"
          lang={chrome.language}
          style={{ "--reading-size": readingSizeToRem(chrome.size) } as React.CSSProperties}
        >
          {renderReaderView(view, workEntryId, handlers, chrome.language)}
        </div>
      </motion.div>
      <section aria-labelledby="work-notes-heading" className="readerWorkNotes">
        <h2 id="work-notes-heading">Your notes</h2>
        <NoteList
          emptyLabel="No notes yet. Select text in the reader to add one."
          notes={handlers.notes}
          onDelete={(note) => handlers.onDeleteNote(workEntryId, note)}
          onEdit={(note) => handlers.onEditNote(workEntryId, note)}
          onJump={(note) => handlers.onJumpToBlock(note)}
          templates={handlers.templates}
        />
      </section>
    </div>
  );
}

function renderReaderView(
  view: ReaderView,
  workEntryId: string,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
  if (view.units.length === 0) {
    return <p>This work has no content yet.</p>;
  }

  return (
    <article aria-label="Reading" className="reader">
      {view.units.map((unit) => renderUnit(unit, workEntryId, handlers, language))}
    </article>
  );
}

function renderUnit(
  unit: ReaderUnit,
  workEntryId: string,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
  return (
    <section className="readerUnit" key={unit.entryId}>
      {unit.title === undefined ? null : <h2 className="readerUnitTitle">{unit.title}</h2>}
      {unit.blocks.map((block) => renderBlock(block, workEntryId, handlers, language))}
    </section>
  );
}

function renderBlock(
  block: ReaderBlock,
  workEntryId: string,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
  const blockNotes = notesForBlock(handlers.notes, block.entryId);
  const annotated = blockNotes.length > 0;
  const className = annotated
    ? `readerBlock readerBlock--annotated ${annotationHueClass((blockNotes[0] as NoteDto).templateId)}`
    : "readerBlock";
  const born = handlers.bornBlockEntryId === block.entryId;
  // A born block remounts (new key) so the highlight-birth motion replays; non-born blocks
  // render statically.
  const birth = born ? highlightBirthMotion(handlers.prefersReducedMotion) : {};

  // Keyboard and touch open the editor too, not just the mouse: a selection inside a
  // focusable block is captured on key-up and touch-end as well as mouse-up.
  const capture = (event: React.SyntheticEvent<HTMLElement>): void =>
    handlers.onCaptureSelection(event.currentTarget, block, workEntryId, language);

  return (
    <motion.div
      className={className}
      data-block-id={block.entryId}
      data-born={born ? "true" : undefined}
      data-has-notes={annotated ? "true" : undefined}
      key={born ? `${block.entryId}-born` : block.entryId}
      onKeyUp={capture}
      onMouseUp={capture}
      onTouchEnd={capture}
      tabIndex={0}
      {...birth}
    >
      <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
        {block.markdown}
      </Markdown>
      {annotated ? (
        <button
          className="readerBlockNotes"
          onClick={() => handlers.onOpenBlockNotes(block.entryId, workEntryId)}
          onMouseUp={(event) => event.stopPropagation()}
          type="button"
        >
          {blockNotes.length === 1 ? "View 1 note" : `View ${blockNotes.length} notes`}
        </button>
      ) : null}
    </motion.div>
  );
}

type PanelHandlers = Readonly<{
  onClose: () => void;
  onDeleteNote: (workEntryId: string, note: NoteDto) => void;
  onEditNote: (workEntryId: string, note: NoteDto) => void;
  onJumpToBlock: (note: NoteDto) => void;
  onSavedNote: (workEntryId: string, note: NoteDto) => void;
}>;

function renderPanel(
  panel: NotePanel | undefined,
  notes: ReadonlyArray<NoteDto>,
  templates: ReadonlyArray<NoteTemplateDto>,
  handlers: PanelHandlers
): React.JSX.Element | null {
  if (panel === undefined) {
    return null;
  }

  if (panel.kind === "block") {
    return (
      <aside aria-label="Block notes" className="readerBlockNotesPanel">
        <h2>Notes on this selection</h2>
        <NoteList
          emptyLabel="This block has no notes."
          notes={notesForBlock(notes, panel.blockEntryId)}
          onDelete={(note) => handlers.onDeleteNote(panel.workEntryId, note)}
          onEdit={(note) => handlers.onEditNote(panel.workEntryId, note)}
          onJump={(note) => handlers.onJumpToBlock(note)}
          templates={templates}
        />
        <button onClick={handlers.onClose} type="button">
          Close
        </button>
      </aside>
    );
  }

  return (
    <NoteEditor
      key={
        panel.kind === "create"
          ? `create-${panel.draft.blockEntryId}`
          : `edit-${panel.note.entryId}`
      }
      onClose={handlers.onClose}
      onSaved={(note) => handlers.onSavedNote(panel.workEntryId, note)}
      target={
        panel.kind === "create"
          ? { draft: panel.draft, kind: "create" }
          : { kind: "edit", note: panel.note }
      }
      templates={templates}
      workEntryId={panel.workEntryId}
    />
  );
}
