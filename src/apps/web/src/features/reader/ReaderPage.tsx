import { memo, useCallback, useEffect, useState } from "react";
import { motion } from "framer-motion";
import Markdown, { type Options } from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { NoteDto, NoteTemplateDto, WorkListItemDto } from "@whetstone/contracts";

import { motionSprings, withReducedMotion } from "../../shared/motion/motion";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { Sheet } from "../../shared/ui/Sheet";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";
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
import { resolveOpening } from "./readingPosition";
import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";
import { useReadingPositionWriter, type SaveReadingPosition } from "./useReadingPositionWriter";
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

// Render the source's in-content links as non-navigating text. v0 does not resolve
// cross-document in-book links (blocks are standalone), so a live `<a href>` would hijack the
// click — navigating the hash-router SPA away (observed: jumping home) and stealing the click
// from the lookup/annotation selection. Keep the link text; drop the navigation. Empty
// index/cross-reference anchors become an empty, non-clickable span.
const markdownComponents: Options["components"] = {
  a: ({ children }) => <span className="readerLink">{children}</span>
};

// Immersive-reader chrome state shared with the reading view: the language-aware paper
// surface, the text-size control, the auto-hiding header, the receding reading tools, and the
// entrance motion.
type ReaderChrome = Readonly<{
  language: string;
  onSizeChange: (size: ReadingSize) => void;
  prefersReducedMotion: boolean;
  scroll: ReaderScroll;
  size: ReadingSize;
  title: string;
  tools: ReaderTools;
}>;

// The receding reading tools whose open state lives in ReaderPage: the 目录 drawer and the
// "Your notes" panel, both toggled from the ReadingHeader so they hide with the rest of the
// chrome while reading.
type ReaderTools = Readonly<{
  notesCount: number;
  notesOpen: boolean;
  onCloseToc: () => void;
  onSetNotesOpen: (open: boolean) => void;
  onToggleNotes: () => void;
  onToggleToc: () => void;
  tocOpen: boolean;
}>;

type ReadingState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; workEntryId: string }>
  | Readonly<{ status: "error"; workEntryId: string }>
  | Readonly<{
      activeUnitIndex: number;
      // One-shot scroll target carried in state (not refs): the consuming effect reads it after
      // the unit renders and scrolls there. Cleared by the next unit-reducer transition so a
      // stale target never re-scrolls. `scrollBlockEntryId` jumps to a block — a deep link, a jump
      // to a note/highlight, or a restored reading position's block anchor.
      scrollBlockEntryId?: string | undefined;
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
    reading: {
      ...state.reading,
      activeUnitIndex: clampUnitIndex(state.reading.view, index),
      scrollBlockEntryId: undefined
    }
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

  return {
    ...state,
    reading: {
      ...state.reading,
      activeUnitIndex: target,
      scrollBlockEntryId: blockEntryId
    }
  };
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
  const [size, setSize] = useState<ReadingSize>(defaultReadingSize);
  // The 目录 drawer and the "Your notes" panel are tools that recede with the reading header:
  // their open state lives here (not inside ReaderToc) so opening a unit / jumping / opening a
  // work can dismiss them alongside the other overlays.
  const [tocOpen, setTocOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const scroll = useReaderScroll();
  const toast = useToast();
  // The reader's position is durable server state (per user + work). Saving is best-effort: a
  // network failure (offline) is swallowed so it never breaks reading or logs an error. The
  // callback identity is stable so the writer effect does not re-subscribe.
  const savePosition = useCallback<SaveReadingPosition>((workEntryId, position) => {
    void saveReadingPosition(workEntryId, position).catch(() => {
      // Best-effort durable position; ignore network failures.
    });
  }, []);
  useReadingPositionWriter(savePosition, viewingPosition(state));

  // After the active unit renders, consume the viewing scroll target: jump to a requested block —
  // a deep link, a jump to a note/highlight in another unit, or a restored reading position's block
  // anchor. The target lives in the reading state and is cleared by the next unit-reducer
  // transition, so this effect only performs the scroll — it never calls setState, and uses no refs.
  useEffect(() => {
    if (state.status !== "ready" || state.reading.status !== "viewing") {
      return;
    }

    const { scrollBlockEntryId } = state.reading;

    if (scrollBlockEntryId !== undefined) {
      scrollToBlock(scrollBlockEntryId);
    }
  }, [state]);

  useEffect(() => {
    // The initial open is inlined here (rather than calling a component-scoped openWork) so the
    // effect has no forward reference and no external function dependency: on mount it fetches
    // works, and when initialWorkEntryId matches one it opens it (loading → fetch content + notes
    // → build view → resolve the opening plan → viewing, with the scroll target carried in state).
    async function openInitialWork(
      works: ReadonlyArray<WorkListItemDto>,
      workEntryId: string,
      deepLinkBlockEntryId?: string
    ): Promise<void> {
      setState({ reading: { status: "loading", workEntryId }, status: "ready", works });
      setPanel(undefined);
      setCapture(undefined);
      setLookup(undefined);
      setBornBlockEntryId(undefined);
      setTocOpen(false);
      setNotesOpen(false);
      setNotes([]);

      try {
        const content = await fetchWorkContent(workEntryId);
        const noteList = await fetchNotes(workEntryId);
        setNotes(noteList.notes);
        const view = buildReaderView(content);
        const savedPosition = await fetchReadingPosition(workEntryId).catch(() => undefined);
        const plan = resolveOpening(view, {
          ...(deepLinkBlockEntryId === undefined ? {} : { deepLinkBlockEntryId }),
          ...(savedPosition === undefined ? {} : { savedPosition })
        });

        setState({
          reading: {
            activeUnitIndex: plan.unitIndex,
            status: "viewing",
            view,
            workEntryId,
            ...(plan.scrollBlockEntryId === undefined
              ? {}
              : { scrollBlockEntryId: plan.scrollBlockEntryId })
          },
          status: "ready",
          works
        });
      } catch {
        setState({ reading: { status: "error", workEntryId }, status: "ready", works });
      }
    }

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

        void openInitialWork(works, requested.work.entryId, initialBlockEntryId);
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

  // Open a reading unit from the 目录: switch the active unit and close any open overlays so
  // the chapter swap is clean.
  function selectUnit(index: number): void {
    setState((current) => applyUnitSelection(current, index));
    setPanel(undefined);
    setCapture(undefined);
    setLookup(undefined);
    setTocOpen(false);
    setNotesOpen(false);
  }

  // Jump to a block (a note card or a highlight): load the unit that holds it when it differs
  // from the open one, then scroll to it once rendered. Same-unit jumps scroll immediately via
  // the same pending-scroll effect.
  function jumpToBlock(blockEntryId: string): void {
    setState((current) => applyUnitForBlock(current, blockEntryId));
    setPanel(undefined);
    setTocOpen(false);
    setNotesOpen(false);
  }

  const onCaptureSelection = useCallback(
    (
      blockElement: HTMLElement,
      block: ReaderBlock,
      workEntryId: string,
      language: string
    ): void => {
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
    },
    []
  );

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
          state: response.found ? { entry: response.entry, status: "loaded" } : { status: "empty" },
          term
        });
      })
      .catch(() => setLookup({ anchorRect, state: { status: "error" }, term }));
  }

  const onOpenBlockNotes = useCallback((blockEntryId: string, workEntryId: string): void => {
    setPanel({ blockEntryId, kind: "block", workEntryId });
  }, []);

  function onEditNote(workEntryId: string, note: NoteDto): void {
    // Editing opens its own Sheet; close the notes panel so the two do not stack.
    setNotesOpen(false);
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
    <section aria-label="Reader" className="readerShell">
      <a aria-label="Back to Library" className="readerExit" href="#/">
        ← Library
      </a>

      {state.status === "loadingWorks" ? <LoadingIndicator label="Loading works…" /> : null}
      {state.status === "worksError" ? <p role="alert">Could not load works.</p> : null}

      {state.status === "ready"
        ? renderReady(state.works, state.reading, handlers, selectUnit, {
            onSizeChange: setSize,
            prefersReducedMotion,
            scroll,
            size,
            tools: {
              notesCount: notes.length,
              notesOpen,
              onCloseToc: () => setTocOpen(false),
              onSetNotesOpen: setNotesOpen,
              onToggleNotes: () => setNotesOpen((value) => !value),
              onToggleToc: () => setTocOpen((value) => !value),
              tocOpen
            }
          })
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
  onSelectUnit: (index: number) => void,
  chromeBase: ReaderChromeBase
): React.JSX.Element {
  const openWorkEntryId = reading.status === "idle" ? undefined : reading.workEntryId;
  const openWork = works.find((item) => item.work.entryId === openWorkEntryId);
  const chrome: ReaderChrome = {
    ...chromeBase,
    language: openWork?.work.language ?? "en",
    title: openWork?.work.title ?? ""
  };

  return renderReading(reading, handlers, onSelectUnit, chrome);
}

function renderReading(
  reading: ReadingState,
  handlers: ReaderHandlers,
  onSelectUnit: (index: number) => void,
  chrome: ReaderChrome
): React.JSX.Element {
  switch (reading.status) {
    case "idle":
      return (
        <div className="readerEmpty">
          <p>Open a work from your Library</p>
        </div>
      );
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
  const tools = chrome.tools;
  // A multi-unit work navigates by its 目录; a single-unit work (an essay) reads without it.
  const hasToc = units.length > 1;
  const toc = hasToc ? (
    <ReaderToc
      activeIndex={activeUnitIndex}
      items={units.map((unit, index) => ({
        entryId: unit.entryId,
        label: unitTocLabel(unit, index)
      }))}
      onClose={tools.onCloseToc}
      onSelect={onSelectUnit}
      open={tools.tocOpen}
    />
  ) : null;

  return (
    <div className="readerReading">
      {toc}
      <div className="readerReadingMain">
        <ReadingHeader
          hasToc={hasToc}
          hidden={chrome.scroll.headerHidden}
          notesCount={tools.notesCount}
          notesOpen={tools.notesOpen}
          onSizeChange={chrome.onSizeChange}
          onToggleNotes={tools.onToggleNotes}
          onToggleToc={tools.onToggleToc}
          progress={workProgress(activeUnitIndex, units.length, chrome.scroll.progress)}
          size={chrome.size}
          title={chrome.title}
          tocOpen={tools.tocOpen}
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
      </div>
      <Sheet onOpenChange={tools.onSetNotesOpen} open={tools.notesOpen} title="Your notes">
        <div className="readerNotesPanel">
          <NoteList
            emptyLabel="No notes yet. Select text in the reader to add one."
            notes={handlers.notes}
            onDelete={(note) => handlers.onDeleteNote(workEntryId, note)}
            onEdit={(note) => handlers.onEditNote(workEntryId, note)}
            onJump={(note) => handlers.onJumpToBlock(note)}
            templates={handlers.templates}
          />
        </div>
      </Sheet>
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
  // The reading area is whetstone's own selection surface: suppress the right-click context
  // menu so it doesn't open over a selection (the toolbar is the affordance here). The touch
  // long-press callout (mobile / Capacitor WebView) is suppressed in CSS, with text kept
  // selectable. Scoped to the reading article, never the whole app.
  return (
    <article
      aria-label="Reading"
      className="reader"
      onContextMenu={(event) => event.preventDefault()}
    >
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
      {unit.blocks.map((block) => {
        // A born block remounts (new key) so the highlight-birth motion replays.
        const born = handlers.bornBlockEntryId === block.entryId;

        return (
          <ReaderBlockView
            block={block}
            born={born}
            key={born ? `${block.entryId}-born` : block.entryId}
            language={language}
            notes={handlers.notes}
            onCaptureSelection={handlers.onCaptureSelection}
            onOpenBlockNotes={handlers.onOpenBlockNotes}
            prefersReducedMotion={handlers.prefersReducedMotion}
            workEntryId={workEntryId}
          />
        );
      })}
    </section>
  );
}

type ReaderBlockViewProps = Readonly<{
  block: ReaderBlock;
  born: boolean;
  language: string;
  notes: ReadonlyArray<NoteDto>;
  onCaptureSelection: (
    blockElement: HTMLElement,
    block: ReaderBlock,
    workEntryId: string,
    language: string
  ) => void;
  onOpenBlockNotes: (blockEntryId: string, workEntryId: string) => void;
  prefersReducedMotion: boolean;
  workEntryId: string;
}>;

// One rendered block. Memoized so it re-renders only when its own data/state changes: with
// stable props (memoized handlers, a stable notes array, a per-block `born` flag), opening the
// selection toolbar / lookup / a notes panel or switching a template no longer re-runs the
// react-markdown pipeline for every block in the unit — the cause of the ~500ms handlers. Only
// the born/animating block pays for framer-motion; every other block is a plain element.
const ReaderBlockView = memo(function ReaderBlockView({
  block,
  born,
  language,
  notes,
  onCaptureSelection,
  onOpenBlockNotes,
  prefersReducedMotion,
  workEntryId
}: ReaderBlockViewProps): React.JSX.Element {
  const blockNotes = notesForBlock(notes, block.entryId);
  const annotated = blockNotes.length > 0;
  const className = annotated
    ? `readerBlock readerBlock--annotated ${annotationHueClass((blockNotes[0] as NoteDto).templateId)}`
    : "readerBlock";

  // Keyboard and touch open the editor too, not just the mouse: a selection inside a
  // focusable block is captured on key-up and touch-end as well as mouse-up.
  const capture = (event: React.SyntheticEvent<HTMLElement>): void =>
    onCaptureSelection(event.currentTarget, block, workEntryId, language);

  const body = (
    <>
      <Markdown
        components={markdownComponents}
        rehypePlugins={rehypePlugins}
        remarkPlugins={remarkPlugins}
      >
        {block.markdown}
      </Markdown>
      {annotated ? (
        <button
          className="readerBlockNotes"
          onClick={() => onOpenBlockNotes(block.entryId, workEntryId)}
          onMouseUp={(event) => event.stopPropagation()}
          type="button"
        >
          {blockNotes.length === 1 ? "View 1 note" : `View ${blockNotes.length} notes`}
        </button>
      ) : null}
    </>
  );

  const commonProps = {
    className,
    "data-block-id": block.entryId,
    "data-born": born ? "true" : undefined,
    "data-has-notes": annotated ? "true" : undefined,
    onKeyUp: capture,
    onMouseUp: capture,
    onTouchEnd: capture,
    tabIndex: 0
  } as const;

  if (born) {
    return (
      <motion.div {...commonProps} {...highlightBirthMotion(prefersReducedMotion)}>
        {body}
      </motion.div>
    );
  }

  return <div {...commonProps}>{body}</div>;
});

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
