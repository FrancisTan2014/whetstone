import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import Markdown, { type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteDto, NoteTemplateDto, WorkListItemDto } from "@whetstone/contracts";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { useToast } from "../../shared/ui/toast/ToastProvider";
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
import { isUnitTitleRedundant } from "./readerHeadings";
import { clampUnitIndex, targetUnitForBlock, unitTocLabel, workProgress } from "./readerNavigation";
import { createLocalStoragePositionStore, resolveOpening } from "./readingPosition";
import { useReadingPositionWriter } from "./useReadingPositionWriter";
import { ReaderToc } from "./ReaderToc";
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
  | Readonly<{
      activeUnitIndex: number;
      status: "viewing";
      view: ReaderView;
      workEntryId: string;
    }>;

type ReaderState =
  | Readonly<{ status: "loadingWorks" }>
  | Readonly<{ status: "worksError" }>
  | Readonly<{ reading: ReadingState; status: "ready"; works: ReadonlyArray<WorkListItemDto> }>;

// Switching the open unit to a TOC selection: clamp the index into range and keep the rest
// of the viewing state. A no-op for any non-viewing state so the reducer is total. Pure and
// exported so the unit-selection logic tests without the component.
export function applyUnitSelection(state: ReaderState, index: number): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  return {
    ...state,
    reading: { ...state.reading, activeUnitIndex: clampUnitIndex(state.reading.view, index) }
  };
}

// Switching the open unit to the one that holds a block (jumping to a note or highlight).
// Falls back to the current unit when the block is not in the work, and is a no-op for any
// non-viewing state. Pure and exported so the jump-across-units logic tests in isolation.
export function applyUnitForBlock(state: ReaderState, blockEntryId: string): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  const target = targetUnitForBlock(
    state.reading.view,
    blockEntryId,
    state.reading.activeUnitIndex
  );

  return { ...state, reading: { ...state.reading, activeUnitIndex: target } };
}

// The work + active reading unit currently being read, or undefined when not viewing a unit
// (idle/loading/error, or a work with no units). Drives where the reading position is saved.
// Pure and exported so it tests without the component.
export function viewingPosition(
  state: ReaderState
): Readonly<{ unitEntryId: string; workEntryId: string }> | undefined {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return undefined;
  }

  const unit = state.reading.view.units[state.reading.activeUnitIndex];

  if (unit === undefined) {
    return undefined;
  }

  return { unitEntryId: unit.entryId, workEntryId: state.reading.workEntryId };
}

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
// An optional `?block=<entryId>` deep-links to a specific block: the reader opens the unit that
// holds it and scrolls there.
type ReaderPageProps = Readonly<{
  initialBlockEntryId?: string | undefined;
  initialWorkEntryId?: string | undefined;
}>;

// A view-only vocabulary lookup driven from the selection toolbar: the selected term and
// its fetch state. Lookup never creates, pre-fills, or edits a note.
type LookupView = Readonly<{ anchorRect?: DOMRect | undefined; state: LookupState; term: string }>;

export function ReaderPage({
  initialBlockEntryId,
  initialWorkEntryId
}: ReaderPageProps): React.JSX.Element {
  const [state, setState] = useState<ReaderState>({ status: "loadingWorks" });
  const [templates, setTemplates] = useState<ReadonlyArray<NoteTemplateDto>>([]);
  const [notes, setNotes] = useState<ReadonlyArray<NoteDto>>([]);
  const [panel, setPanel] = useState<NotePanel | undefined>(undefined);
  const [capture, setCapture] = useState<SelectionCapture | undefined>(undefined);
  const [lookup, setLookup] = useState<LookupView | undefined>(undefined);
  const [bornBlockEntryId, setBornBlockEntryId] = useState<string | undefined>(undefined);
  const [pendingScrollBlockEntryId, setPendingScrollBlockEntryId] = useState<string | undefined>(
    undefined
  );
  const [pendingScrollOffset, setPendingScrollOffset] = useState<number | undefined>(undefined);
  const [size, setSize] = useState<ReadingSize>(defaultReadingSize);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const scroll = useReaderScroll();
  const toast = useToast();
  // localStorage-backed per-work reading position; created once so its identity is stable.
  const positionStore = useMemo(() => createLocalStoragePositionStore(window.localStorage), []);
  useReadingPositionWriter(positionStore, viewingPosition(state));

  useEffect(() => {
    setPrefersReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  // After the active unit renders, scroll to a requested block (a deep link, or a jump to a
  // note/highlight in another unit). The block is in the DOM by the time this effect runs.
  useEffect(() => {
    if (pendingScrollBlockEntryId === undefined) {
      return;
    }

    scrollToBlock(pendingScrollBlockEntryId);
    setPendingScrollBlockEntryId(undefined);
  }, [pendingScrollBlockEntryId]);

  // After the saved unit renders, restore its best-effort scroll offset.
  useEffect(() => {
    if (pendingScrollOffset === undefined) {
      return;
    }

    window.scrollTo(0, pendingScrollOffset);
    setPendingScrollOffset(undefined);
  }, [pendingScrollOffset]);

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

        void openWork(works, requested.work.entryId, initialBlockEntryId);
      })
      .catch(() => setState({ status: "worksError" }));
  }, [initialBlockEntryId, initialWorkEntryId]);

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
    workEntryId: string,
    deepLinkBlockEntryId?: string
  ): Promise<void> {
    setState({ reading: { status: "loading", workEntryId }, status: "ready", works });
    setPanel(undefined);
    setCapture(undefined);
    setLookup(undefined);
    setBornBlockEntryId(undefined);
    setNotes([]);

    try {
      const content = await fetchWorkContent(workEntryId);
      await refreshNotes(workEntryId);
      const view = buildReaderView(content);
      const savedPosition = positionStore.read(workEntryId);
      const plan = resolveOpening(view, {
        ...(deepLinkBlockEntryId === undefined ? {} : { deepLinkBlockEntryId }),
        ...(savedPosition === undefined ? {} : { savedPosition })
      });

      setState({
        reading: {
          activeUnitIndex: plan.unitIndex,
          status: "viewing",
          view,
          workEntryId
        },
        status: "ready",
        works
      });

      if (plan.scrollBlockEntryId !== undefined) {
        setPendingScrollBlockEntryId(plan.scrollBlockEntryId);
      }

      if (plan.scrollOffset !== undefined) {
        setPendingScrollOffset(plan.scrollOffset);
      }
    } catch {
      setState({ reading: { status: "error", workEntryId }, status: "ready", works });
    }
  }

  // Open a reading unit from the 目录: switch the active unit and close any open overlays so
  // the chapter swap is clean.
  function selectUnit(index: number): void {
    setState((current) => applyUnitSelection(current, index));
    setPanel(undefined);
    setCapture(undefined);
    setLookup(undefined);
  }

  // Jump to a block (a note card or a highlight): load the unit that holds it when it differs
  // from the open one, then scroll to it once rendered. Same-unit jumps scroll immediately via
  // the same pending-scroll effect.
  function jumpToBlock(blockEntryId: string): void {
    setState((current) => applyUnitForBlock(current, blockEntryId));
    setPanel(undefined);
    setPendingScrollBlockEntryId(blockEntryId);
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
    const anchorRect = active.anchorRect;
    setCapture(undefined);
    setLookup({ anchorRect, state: { status: "loading" }, term });

    lookupTerm(term, active.language)
      .then((response) => {
        setLookup({
          anchorRect,
          state: response.found
            ? { attribution: response.attribution, entry: response.entry, status: "loaded" }
            : { status: "empty" },
          term
        });
      })
      .catch(() => setLookup({ anchorRect, state: { status: "error" }, term }));
  }

  function onOpenBlockNotes(blockEntryId: string, workEntryId: string): void {
    setPanel({ blockEntryId, kind: "block", workEntryId });
  }

  function onEditNote(workEntryId: string, note: NoteDto): void {
    setPanel({ kind: "edit", note, workEntryId });
  }

  async function onSavedNote(workEntryId: string, note: NoteDto): Promise<void> {
    setPanel(undefined);
    setBornBlockEntryId(note.blockEntryId);
    toast.success("Note saved.");
    await refreshNotes(workEntryId);
  }

  async function onDeleteNote(workEntryId: string, note: NoteDto): Promise<void> {
    try {
      await deleteNote(workEntryId, note.entryId);
    } catch {
      toast.error("Could not delete the note. Please try again.");
      return;
    }

    setPanel(undefined);
    toast.success("Note deleted.");
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
    onJumpToBlock: (note) => jumpToBlock(note.blockEntryId),
    onOpenBlockNotes,
    prefersReducedMotion,
    templates
  };

  return (
    <section aria-labelledby="reader-heading" className="readerShell">
      <h1 id="reader-heading">Reader</h1>

      {state.status === "loadingWorks" ? <LoadingIndicator label="Loading works…" /> : null}
      {state.status === "worksError" ? <p role="alert">Could not load works.</p> : null}

      {state.status === "ready"
        ? renderReady(
            state.works,
            state.reading,
            handlers,
            (workEntryId) => void openWork(state.works, workEntryId),
            selectUnit,
            { onSizeChange: setSize, prefersReducedMotion, scroll, size }
          )
        : null}

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
          anchorRect={lookup.anchorRect}
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
        onJumpToBlock: (note) => jumpToBlock(note.blockEntryId),
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
  onSelectUnit: (index: number) => void,
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

      {renderReading(reading, handlers, onSelectUnit, chrome)}
    </div>
  );
}

function renderReading(
  reading: ReadingState,
  handlers: ReaderHandlers,
  onSelectUnit: (index: number) => void,
  chrome: ReaderChrome
): React.JSX.Element {
  switch (reading.status) {
    case "idle":
      return <p className="readerHint">Select a work to start reading.</p>;
    case "loading":
      return <LoadingIndicator label="Loading the work…" />;
    case "error":
      return <p role="alert">Could not load this work. Please try again.</p>;
    case "viewing":
      return renderViewing(
        reading.view,
        reading.workEntryId,
        reading.activeUnitIndex,
        onSelectUnit,
        handlers,
        chrome
      );
  }
}

function renderViewing(
  view: ReaderView,
  workEntryId: string,
  activeUnitIndex: number,
  onSelectUnit: (index: number) => void,
  handlers: ReaderHandlers,
  chrome: ReaderChrome
): React.JSX.Element {
  const entrance = withReducedMotion(motionSprings.gentle, chrome.prefersReducedMotion);
  const units = view.units;
  // A multi-unit work navigates by its 目录; a single-unit work (an essay) reads without it.
  const toc =
    units.length > 1 ? (
      <ReaderToc
        activeIndex={activeUnitIndex}
        items={units.map((unit, index) => ({
          entryId: unit.entryId,
          label: unitTocLabel(unit, index)
        }))}
        onSelect={onSelectUnit}
      />
    ) : null;

  return (
    <div className={toc === null ? "readerReading" : "readerReading readerReading--withToc"}>
      {toc}
      <div className="readerReadingMain">
        <ReadingHeader
          hidden={chrome.scroll.headerHidden}
          onSizeChange={chrome.onSizeChange}
          progress={workProgress(activeUnitIndex, units.length, chrome.scroll.progress)}
          size={chrome.size}
          title={chrome.title}
        />
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          className="readerEntrance"
          initial={{ opacity: 0, y: 8 }}
          key={`${workEntryId}-${activeUnitIndex}`}
          transition={entrance}
        >
          <div
            className="reading-surface readerPaper"
            lang={chrome.language}
            style={{ "--reading-size": readingSizeToRem(chrome.size) } as React.CSSProperties}
          >
            {renderReaderView(units[activeUnitIndex], workEntryId, handlers, chrome.language)}
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
    </div>
  );
}

function renderReaderView(
  unit: ReaderUnit | undefined,
  workEntryId: string,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
  if (unit === undefined) {
    return <p>This work has no content yet.</p>;
  }

  // Only the current reading unit is rendered, so a whole book never mounts at once.
  return (
    <article aria-label="Reading" className="reader">
      {renderUnit(unit, workEntryId, handlers, language)}
    </article>
  );
}

function renderUnit(
  unit: ReaderUnit,
  workEntryId: string,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
  // The unit title renders as an eyebrow, except when the unit's first heading already says
  // the same thing (then showing both would duplicate it).
  const showTitle = unit.title !== undefined && !isUnitTitleRedundant(unit);

  return (
    <section className="readerUnit" key={unit.entryId}>
      {showTitle ? <h2 className="readerUnitTitle">{unit.title}</h2> : null}
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
