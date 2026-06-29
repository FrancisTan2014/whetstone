import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";

import type { NoteDto, NoteTemplateDto, WorkListItemDto } from "@whetstone/contracts";
import { lookupSourceLabel, lookupSourcesForLanguage } from "@whetstone/contracts";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { Sheet } from "../../shared/ui/Sheet";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";
import { useToast } from "../../shared/ui/toast/ToastProvider";
import { NoteEditor } from "../notes/NoteEditor";
import { NoteList } from "../notes/NoteList";
import { captureBlockSelection, type NoteDraft } from "../notes/noteCapture";
import { deleteNote, fetchNoteTemplates, fetchNotes } from "../notes/notesApi";
import { SelectionToolbar } from "../notes/SelectionToolbar";
import { blockGutterHueClass, noteMarkHueClass } from "./annotationHue.tokens";
import { ChapterPager } from "./ChapterPager";
import { LookupPanel, type LookupState, type LookupTab } from "../lookup/LookupPanel";
import { lookupTerm } from "../lookup/lookupApi";
import {
  eventTargetClosest,
  isCrossBlockSelection,
  readBlockSelection,
  releasedBlockElement
} from "./blockSelection";
import { highlightBirthMotion } from "./highlightBirth";
import { BlockContent } from "./mdastBlock";
import type { NoteMark } from "./noteMarks";
import { selectionOverlapsNote } from "./noteOverlap";
import { fetchUnitContent, fetchWorks, fetchWorkStructure, locateBlockUnit } from "./readerApi";
import {
  buildReaderStructure,
  toReaderBlocks,
  type ReaderBlock,
  type ReaderStructure,
  type ReaderUnit
} from "./readerModel";
import { isUnitTitleRedundant } from "./readerHeadings";
import {
  clampUnitIndex,
  unitIndexForEntryId,
  unitTocLabel,
  workProgress
} from "./readerNavigation";
import { resolveOpening } from "./readingPosition";
import { readingEntranceMotion } from "./readingEntrance";
import { fetchReadingPosition, saveReadingPosition } from "./readingPositionApi";
import { useReadingPositionWriter, type SaveReadingPosition } from "./useReadingPositionWriter";
import { ReaderToc } from "./ReaderToc";
import { ReadingHeader } from "./ReadingHeader";
import { readingMeasureRem } from "./readingMeasure";
import { defaultReadingSize, readingSizeToRem, type ReadingSize } from "./readingSize";
import { scrollToBlock } from "./scrollToBlock";
import { selectionRect } from "./selectionRect";
import { useReaderScroll, type ReaderScroll } from "./useReaderScroll";

// Immersive-reader chrome state shared with the reading view: the language-aware paper
// surface, the text-size control, the auto-hiding header, the receding reading tools, and the
// entrance motion.
type ReaderChrome = Readonly<{
  chromeHidden: boolean;
  isNarrow: boolean;
  language: string;
  onSizeChange: (size: ReadingSize) => void;
  onToggleChrome: () => void;
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

// The active reading unit's load lifecycle: its blocks are fetched on demand when the unit
// becomes active. `loading` shows a spinner, `error` shows a retry affordance, and `loaded`
// carries the unit's ordered blocks for rendering and selection.
type ActiveUnit =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loaded"; unit: ReaderUnit }>;

type ReadingState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; workEntryId: string }>
  | Readonly<{ status: "error"; workEntryId: string }>
  | Readonly<{
      // The active unit's blocks, fetched on demand. `loadNonce` keys the unit-load effect so a
      // Retry re-fetches the same unit; `activeUnitIndex` points into `structure.units`.
      activeUnit: ActiveUnit;
      activeUnitIndex: number;
      loadNonce: number;
      // One-shot scroll target carried in state (not refs): the consuming effect reads it after
      // the unit's blocks render and scrolls there. Cleared by the next unit-reducer transition so
      // a stale target never re-scrolls. `scrollBlockEntryId` jumps to a block — a deep link, a
      // jump to a note/highlight, or a restored reading position's block anchor.
      scrollBlockEntryId?: string | undefined;
      status: "viewing";
      structure: ReaderStructure;
      workEntryId: string;
    }>;

type ReaderState =
  | Readonly<{ status: "loadingWorks" }>
  | Readonly<{ status: "worksError" }>
  | Readonly<{ reading: ReadingState; status: "ready"; works: ReadonlyArray<WorkListItemDto> }>;

// Switching the open unit to a TOC selection: clamp the index into range. Re-selecting the open
// unit only clears any pending scroll; selecting a different unit moves to it with a fresh load
// (loading state + bumped `loadNonce`) and no scroll target. A no-op for any non-viewing state so
// the reducer is total. Pure and exported so the unit-selection logic tests without the component.
export function applyUnitSelection(state: ReaderState, index: number): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  const clamped = clampUnitIndex(state.reading.structure, index);

  if (clamped === state.reading.activeUnitIndex) {
    return { ...state, reading: { ...state.reading, scrollBlockEntryId: undefined } };
  }

  return {
    ...state,
    reading: {
      ...state.reading,
      activeUnit: { status: "loading" },
      activeUnitIndex: clamped,
      loadNonce: state.reading.loadNonce + 1,
      scrollBlockEntryId: undefined
    }
  };
}

// Switching the open unit to the one a locator resolved for a block (jumping to a note or
// highlight, or a deep link). The owning unit's entry id is resolved to its index; an unknown unit
// (a locator miss for a removed block) no-ops. A same-unit jump only sets the scroll target;
// a cross-unit jump moves to the unit with a fresh load and scrolls once its blocks render. A
// no-op for any non-viewing state. Pure and exported so the jump-across-units logic tests alone.
export function applyUnitForBlock(
  state: ReaderState,
  unitEntryId: string,
  blockEntryId: string
): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  const index = unitIndexForEntryId(state.reading.structure, unitEntryId);

  if (index === undefined) {
    return state;
  }

  if (index === state.reading.activeUnitIndex) {
    return { ...state, reading: { ...state.reading, scrollBlockEntryId: blockEntryId } };
  }

  return {
    ...state,
    reading: {
      ...state.reading,
      activeUnit: { status: "loading" },
      activeUnitIndex: index,
      loadNonce: state.reading.loadNonce + 1,
      scrollBlockEntryId: blockEntryId
    }
  };
}

// The fetched blocks for the active unit have arrived: mark it loaded. Guarded by the active
// unit's entry id so a stale fetch (the reader switched units mid-flight) is ignored. The loaded
// `ReaderUnit` reuses the structure's title for the eyebrow. A no-op for any non-viewing state.
export function applyUnitLoaded(
  state: ReaderState,
  unitEntryId: string,
  blocks: ReadonlyArray<ReaderBlock>
): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  const meta = state.reading.structure.units[state.reading.activeUnitIndex];

  if (meta === undefined || meta.entryId !== unitEntryId) {
    return state;
  }

  const unit: ReaderUnit = {
    blocks,
    entryId: meta.entryId,
    ...(meta.title === undefined ? {} : { title: meta.title })
  };

  return { ...state, reading: { ...state.reading, activeUnit: { status: "loaded", unit } } };
}

// The active unit's fetch failed: mark it errored so the reader shows a retry. Guarded by the
// active unit's entry id so a stale failure is ignored. A no-op for any non-viewing state.
export function applyUnitError(state: ReaderState, unitEntryId: string): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  const meta = state.reading.structure.units[state.reading.activeUnitIndex];

  if (meta === undefined || meta.entryId !== unitEntryId) {
    return state;
  }

  return { ...state, reading: { ...state.reading, activeUnit: { status: "error" } } };
}

// Retry the active unit after a failed fetch: back to loading and bump `loadNonce` so the
// unit-load effect re-runs. A no-op for any non-viewing state.
export function retryActiveUnit(state: ReaderState): ReaderState {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return state;
  }

  return {
    ...state,
    reading: {
      ...state.reading,
      activeUnit: { status: "loading" },
      loadNonce: state.reading.loadNonce + 1
    }
  };
}

// The work + active reading unit currently being read, or undefined when not viewing a unit
// (idle/loading/error, or a work with no units). Read from the structure so the position is known
// as soon as the unit becomes active, before its blocks finish loading. Drives where the reading
// position is saved. Pure and exported so it tests without the component.
export function viewingPosition(
  state: ReaderState
): Readonly<{ unitEntryId: string; workEntryId: string }> | undefined {
  if (state.status !== "ready" || state.reading.status !== "viewing") {
    return undefined;
  }

  const meta = state.reading.structure.units[state.reading.activeUnitIndex];

  if (meta === undefined) {
    return undefined;
  }

  return { unitEntryId: meta.entryId, workEntryId: state.reading.workEntryId };
}

// At most one note panel is open at a time: capturing a new note, editing an existing one, or
// listing the notes anchored to a single block (reopened from its highlight). `noteEntryId` scopes
// a reopened block panel to a single note — the case where the reader activates one note's
// underline rather than the whole-block "View note" affordance.
type NotePanel =
  | Readonly<{ draft: NoteDraft; kind: "create"; workEntryId: string }>
  | Readonly<{ kind: "edit"; note: NoteDto; workEntryId: string }>
  | Readonly<{
      blockEntryId: string;
      kind: "block";
      noteEntryId?: string | undefined;
      workEntryId: string;
    }>;

// A pending capture: a selection has been made and the floating toolbar is offering its
// two actions (Add note / Look up) before the editor opens. `anchorRect` is the
// selection's rect (for positioning), `language` is the open work's language (so a Chinese
// selection routes to CC-CEDICT).
type SelectionCapture = Readonly<{
  anchorRect?: DOMRect | undefined;
  draft: NoteDraft;
  language: string;
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
  onOpenBlockNotes: (blockEntryId: string, workEntryId: string, noteEntryId?: string) => void;
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
type LookupView = Readonly<{
  anchorRect?: DOMRect | undefined;
  requestId: number;
  tabs: ReadonlyArray<LookupTab>;
  term: string;
}>;

// The active reading slice needed to capture a selection from a document-level listener (a
// pointer release that lands in the reading column but outside a block element): the rendered
// blocks to resolve against and the open work's id.
type SelectionContext = Readonly<{
  blocks: ReadonlyArray<ReaderBlock>;
  workEntryId: string;
}>;

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
  // Below the desktop rail's fit width the chrome is a top bar, hidden by default and toggled on a
  // center tap of the reading area. At/above it the rail is persistent (PRODUCT.md: a fixed right-edge
  // rail), so it never recedes on scroll — only mobile auto-hides where space is scarce. The 56rem
  // threshold matches the `min-width: 56rem` rail layout. `useReaderScroll` still drives progress.
  const isNarrow = useMediaQuery("(max-width: 55.999rem)");
  const [chromeTapHidden, setChromeTapHidden] = useState(true);
  const onToggleChrome = useCallback(() => setChromeTapHidden((value) => !value), []);
  const chromeHidden = isNarrow ? chromeTapHidden : false;
  const toast = useToast();
  // The reader's position is durable server state (per user + work). Saving is best-effort: a
  // network failure (offline) is swallowed so it never breaks reading or logs an error. The
  // callback identity is stable so the writer effect does not re-subscribe.
  const savePosition = useCallback<SaveReadingPosition>((workEntryId, position) => {
    void saveReadingPosition(workEntryId, position).catch(() => {
      // Best-effort durable position; ignore network failures.
    });
  }, []);
  // While a restore/deep-link scroll target is pending (set when a work opens to a saved anchor or
  // a jump targets a block), suppress position writes: otherwise the writer's immediate save would
  // capture the pre-scroll top-of-unit block and overwrite the saved anchor before the scroll-to-
  // anchor effect runs. The scroll effect clears it once the scroll has been applied.
  const restorePendingRef = useRef(false);
  // Each lookup gets a monotonic id; an in-flight source from an earlier selection ignores its own
  // result if a newer lookup has opened, so a stale tab never lands in the current panel (#196).
  const lookupSeq = useRef(0);
  const shouldWritePosition = useCallback(() => !restorePendingRef.current, []);
  useReadingPositionWriter(savePosition, viewingPosition(state), shouldWritePosition);

  // After the active unit's blocks render, consume the viewing scroll target: jump to a requested
  // block — a deep link, a jump to a note/highlight in another unit, or a restored reading
  // position's block anchor. The target lives in the reading state and is cleared by the next
  // unit-reducer transition; this effect waits for the unit's blocks to load (so the block exists),
  // then performs the scroll — it never calls setState, and uses no refs.
  useEffect(() => {
    if (state.status !== "ready" || state.reading.status !== "viewing") {
      return;
    }

    const { activeUnit, scrollBlockEntryId } = state.reading;

    if (activeUnit.status !== "loaded") {
      return;
    }

    if (scrollBlockEntryId !== undefined) {
      scrollToBlock(scrollBlockEntryId);
      // The restore/jump scroll has been applied; position writes may resume.
      restorePendingRef.current = false;
    }
  }, [state]);

  // Load the active unit's blocks on demand. Keyed (via the dependency array) on the work, the
  // active unit's entry id, and `loadNonce`, so it re-fetches when the unit changes or a Retry
  // bumps the nonce, but not on unrelated re-renders. The cancel flag plus the entry-id guard in
  // the reducers drop a stale fetch when the reader switches units mid-flight.
  const viewing =
    state.status === "ready" && state.reading.status === "viewing" ? state.reading : undefined;
  const viewingWorkEntryId = viewing?.workEntryId;
  const activeUnitEntryId =
    viewing === undefined ? undefined : viewing.structure.units[viewing.activeUnitIndex]?.entryId;
  const activeUnitLoadNonce = viewing?.loadNonce;

  useEffect(() => {
    if (viewingWorkEntryId === undefined || activeUnitEntryId === undefined) {
      return;
    }

    const work = viewingWorkEntryId;
    const unitEntryId = activeUnitEntryId;
    let cancelled = false;

    fetchUnitContent(work, unitEntryId)
      .then((content) => {
        if (!cancelled) {
          setState((current) => applyUnitLoaded(current, unitEntryId, toReaderBlocks(content)));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState((current) => applyUnitError(current, unitEntryId));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeUnitEntryId, activeUnitLoadNonce, viewingWorkEntryId]);

  useEffect(() => {
    // The initial open is inlined here (rather than calling a component-scoped openWork) so the
    // effect has no forward reference and no external function dependency: on mount it fetches
    // works, and when initialWorkEntryId matches one it opens it (loading → fetch structure + notes
    // → build the structure → resolve the opening plan via the locator → viewing with the active
    // unit loading; its blocks are then fetched by the unit-load effect, with the scroll target
    // carried in state).
    // `active` is flipped false on cleanup so a superseded run never opens a work: under React's
    // dev double-invoke (or a rapid work switch) the effect runs twice, and without this guard the
    // stale run's second `openInitialWork` could reset the active unit back to `loading` after the
    // live run had already loaded it — stranding the spinner. Only the live run proceeds.
    let active = true;

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
        const structureDto = await fetchWorkStructure(workEntryId);
        const noteList = await fetchNotes(workEntryId);
        const structure = buildReaderStructure(structureDto);
        const savedPosition = await fetchReadingPosition(workEntryId).catch(() => undefined);
        const plan = await resolveOpening(structure, {
          locateBlockUnit: (blockEntryId) => locateBlockUnit(workEntryId, blockEntryId),
          ...(deepLinkBlockEntryId === undefined ? {} : { deepLinkBlockEntryId }),
          ...(savedPosition === undefined ? {} : { savedPosition })
        });

        // The open spans several awaits (structure, notes, position, locator). If the effect was torn
        // down meanwhile — an unmount or a work switch — this run is stale: skip every state write so
        // it cannot clobber the live reader (reset notes, or replace the viewing state with the old
        // work). Only the live run reaches the state updates below.
        if (!active) {
          return;
        }

        setNotes(noteList.notes);
        setState({
          reading: {
            activeUnit: { status: "loading" },
            activeUnitIndex: plan.unitIndex,
            loadNonce: 0,
            status: "viewing",
            structure,
            workEntryId,
            ...(plan.scrollBlockEntryId === undefined
              ? {}
              : { scrollBlockEntryId: plan.scrollBlockEntryId })
          },
          status: "ready",
          works
        });
        // Suppress position writes until the restore/deep-link scroll lands, so the saved anchor is
        // not overwritten by the pre-scroll top-of-unit block.
        restorePendingRef.current = plan.scrollBlockEntryId !== undefined;
      } catch {
        // A failure in a stale (torn-down) run must not surface an error over the live reader.
        if (active) {
          setState({ reading: { status: "error", workEntryId }, status: "ready", works });
        }
      }
    }

    fetchWorks()
      .then((list) => {
        if (!active) {
          return;
        }

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
      .catch(() => {
        // A late rejection from a superseded fetchWorks must not replace the live reader.
        if (active) {
          setState({ status: "worksError" });
        }
      });

    return () => {
      active = false;
    };
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

  // Retry loading the active unit after a failed fetch: bump the load nonce so the unit-load
  // effect re-runs against the same unit.
  function retryUnit(): void {
    setState((current) => retryActiveUnit(current));
  }

  // Jump to a block (a note card or a highlight): resolve the unit that owns it via the locator
  // endpoint, then switch to that unit and scroll to the block once its blocks render. A locator
  // miss (a removed block) or a network failure no-ops. Same-unit jumps just set the scroll
  // target, which the pending-scroll effect consumes. Only reachable while viewing (the note UI
  // lives in the viewing render), so the active work id is known.
  function jumpToBlock(blockEntryId: string): void {
    setPanel(undefined);
    setTocOpen(false);
    setNotesOpen(false);

    void locateBlockUnit(viewingWorkEntryId as string, blockEntryId)
      .then((unitEntryId) => {
        if (unitEntryId !== undefined) {
          setState((current) => applyUnitForBlock(current, unitEntryId, blockEntryId));
        }
      })
      .catch(() => {
        // A locator failure leaves the reader where it is; the jump simply does nothing.
      });
  }

  const onCaptureSelection = useCallback(
    (
      blockElement: HTMLElement,
      block: ReaderBlock,
      workEntryId: string,
      language: string
    ): void => {
      const selection = window.getSelection();

      // A selection that spans two blocks cannot anchor to a single block (v0 notes are block-scoped).
      // Tell the reader explicitly instead of silently doing nothing.
      if (isCrossBlockSelection(selection)) {
        toast.error("Select within a single block to add a note.");
        return;
      }

      const blockSelection = readBlockSelection(blockElement, selection);

      if (blockSelection === undefined) {
        return;
      }

      const draft = captureBlockSelection(
        block.entryId,
        block.plaintext,
        blockSelection.precedingText,
        blockSelection.selectedText
      );

      if (draft === undefined) {
        return;
      }

      setCapture({
        anchorRect: selectionRect(selection),
        draft,
        language,
        workEntryId
      });
    },
    [toast]
  );

  // The open work's language (for routing a lookup), derived for every ready state so an idle
  // reader resolves it the same way — no open work falls back to English.
  const readerLanguage = useMemo((): string => {
    if (state.status !== "ready") {
      return "en";
    }

    const workEntryId = state.reading.status === "idle" ? undefined : state.reading.workEntryId;

    return state.works.find((item) => item.work.entryId === workEntryId)?.work.language ?? "en";
  }, [state]);

  // The active reading slice, so a document-level listener can capture a selection released
  // anywhere in the reading column — not only when the pointer is released on the block element.
  const selectionContext = useMemo((): SelectionContext | undefined => {
    if (state.status !== "ready" || state.reading.status !== "viewing") {
      return undefined;
    }

    const { activeUnit } = state.reading;

    if (activeUnit.status !== "loaded") {
      return undefined;
    }

    return {
      blocks: activeUnit.unit.blocks,
      workEntryId: state.reading.workEntryId
    };
  }, [state]);

  // Capture fallback: a pointer release that lands in the reading column but outside a block
  // (e.g. just past a block edge) — the per-block handlers already cover a release on the block
  // itself. Resolve the selection's owning block and capture, so the toolbar appears regardless
  // of where the pointer is released.
  useEffect(() => {
    if (selectionContext === undefined) {
      return;
    }

    const context = selectionContext;

    function onReleaseOutsideBlock(event: Event): void {
      const blockElement = releasedBlockElement(
        event.target,
        window.getSelection(),
        Array.from(document.querySelectorAll<HTMLElement>(".reader [data-block-id]"))
      );

      if (blockElement === undefined) {
        return;
      }

      const block = context.blocks.find((item) => item.entryId === blockElement.dataset.blockId);

      if (block !== undefined) {
        onCaptureSelection(blockElement, block, context.workEntryId, readerLanguage);
      }
    }

    document.addEventListener("mouseup", onReleaseOutsideBlock);
    document.addEventListener("touchend", onReleaseOutsideBlock);

    return () => {
      document.removeEventListener("mouseup", onReleaseOutsideBlock);
      document.removeEventListener("touchend", onReleaseOutsideBlock);
    };
  }, [selectionContext, readerLanguage, onCaptureSelection]);

  // Dismiss the toolbar across its whole lifecycle: a pointer press anywhere outside the toolbar
  // closes it, as does clearing the selection. The explicit ✕ / confirm / lookup still close it.
  useEffect(() => {
    if (capture === undefined) {
      return;
    }

    function onPressOutside(event: Event): void {
      if (eventTargetClosest(event.target, ".selectionToolbar") !== null) {
        return;
      }

      setCapture(undefined);
    }

    function onSelectionCleared(): void {
      const selection = window.getSelection();

      if (selection === null || selection.isCollapsed || selection.toString().trim().length === 0) {
        setCapture(undefined);
      }
    }

    document.addEventListener("mousedown", onPressOutside);
    document.addEventListener("touchstart", onPressOutside);
    document.addEventListener("selectionchange", onSelectionCleared);

    return () => {
      document.removeEventListener("mousedown", onPressOutside);
      document.removeEventListener("touchstart", onPressOutside);
      document.removeEventListener("selectionchange", onSelectionCleared);
    };
  }, [capture]);

  function confirmCapture(active: SelectionCapture): void {
    setCapture(undefined);
    setPanel({
      draft: active.draft,
      kind: "create",
      workEntryId: active.workEntryId
    });
  }

  function lookupSelection(active: SelectionCapture): void {
    const term = active.draft.selectedText;
    const anchorRect = active.anchorRect;
    setCapture(undefined);

    const sources = lookupSourcesForLanguage(active.language);
    const requestId = (lookupSeq.current += 1);
    const initialTabs: LookupTab[] = sources.map((id) => ({
      id,
      label: lookupSourceLabel(id),
      state: { status: "loading" }
    }));
    setLookup({ anchorRect, requestId, tabs: initialTabs, term });

    // Each source is fetched independently and writes only its own tab, so a slow/down/empty source
    // never freezes or empties the others. The requestId guard drops a result whose lookup was closed
    // or superseded by a newer selection, so a stale source can't land under the current term.
    const setTabState = (id: (typeof sources)[number], state: LookupState): void => {
      setLookup((prev) =>
        prev === undefined || prev.requestId !== requestId
          ? prev
          : { ...prev, tabs: prev.tabs.map((tab) => (tab.id === id ? { ...tab, state } : tab)) }
      );
    };

    for (const id of sources) {
      lookupTerm(term, active.language, id)
        .then((response) =>
          setTabState(
            id,
            response.found ? { entry: response.entry, status: "loaded" } : { status: "empty" }
          )
        )
        .catch(() => setTabState(id, { status: "error" }));
    }
  }

  const onOpenBlockNotes = useCallback(
    (blockEntryId: string, workEntryId: string, noteEntryId?: string): void => {
      setPanel({ blockEntryId, kind: "block", noteEntryId, workEntryId });
    },
    []
  );

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
        ? renderReady(state.works, state.reading, handlers, selectUnit, retryUnit, {
            chromeHidden,
            isNarrow,
            onSizeChange: setSize,
            onToggleChrome,
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
          disabledHint={
            selectionOverlapsNote(
              notesForBlock(notes, capture.draft.blockEntryId).map((note) => note.anchor),
              capture.draft
            )
              ? "Notes can't overlap"
              : undefined
          }
          onClose={() => setCapture(undefined)}
          onConfirm={() => confirmCapture(capture)}
          onLookup={() => lookupSelection(capture)}
          prefersReducedMotion={prefersReducedMotion}
        />
      )}

      {lookup === undefined ? null : (
        <LookupPanel
          anchorRect={lookup.anchorRect}
          onOpenChange={() => setLookup(undefined)}
          open={true}
          tabs={lookup.tabs}
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
  onRetryUnit: () => void,
  chromeBase: ReaderChromeBase
): React.JSX.Element {
  const openWorkEntryId = reading.status === "idle" ? undefined : reading.workEntryId;
  const openWork = works.find((item) => item.work.entryId === openWorkEntryId);
  const chrome: ReaderChrome = {
    ...chromeBase,
    language: openWork?.work.language ?? "en",
    title: openWork?.work.title ?? ""
  };

  return renderReading(reading, handlers, onSelectUnit, onRetryUnit, chrome);
}

// A center tap on the reading area toggles the chrome on narrow screens (where it is hidden by
// default). Ignore taps on controls/overlays and taps that complete a text selection, so reading,
// selection, and the tools themselves are never disturbed.
function handleReadingAreaTap(event: React.MouseEvent, chrome: ReaderChrome): void {
  if (!chrome.isNarrow) {
    return;
  }

  const target = event.target as HTMLElement;
  if (target.closest("button, a, input, textarea, [role='dialog'], [role='toolbar']") !== null) {
    return;
  }

  const selection = window.getSelection();
  if (selection !== null && !selection.isCollapsed) {
    return;
  }

  chrome.onToggleChrome();
}

function renderReading(
  reading: ReadingState,
  handlers: ReaderHandlers,
  onSelectUnit: (index: number) => void,
  onRetryUnit: () => void,
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
        reading.structure,
        reading.activeUnit,
        reading.workEntryId,
        reading.activeUnitIndex,
        onSelectUnit,
        onRetryUnit,
        handlers,
        chrome
      );
  }
}

function renderViewing(
  structure: ReaderStructure,
  activeUnit: ActiveUnit,
  workEntryId: string,
  activeUnitIndex: number,
  onSelectUnit: (index: number) => void,
  onRetryUnit: () => void,
  handlers: ReaderHandlers,
  chrome: ReaderChrome
): React.JSX.Element {
  const entrance = readingEntranceMotion(chrome.prefersReducedMotion);
  const units = structure.units;
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
      <div
        className="readerReadingMain"
        onClick={(event) => handleReadingAreaTap(event, chrome)}
        style={
          {
            "--reading-measure": readingMeasureRem(chrome.language),
            "--reading-size": readingSizeToRem(chrome.size)
          } as React.CSSProperties
        }
      >
        <ReadingHeader
          hasToc={hasToc}
          hidden={chrome.chromeHidden}
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
          animate={entrance.animate}
          className="readerEntrance"
          initial={entrance.initial}
          key={`${workEntryId}-${activeUnitIndex}`}
          transition={entrance.transition}
        >
          <div className="reading-surface readerPaper" lang={chrome.language}>
            {renderActiveUnit(
              structure,
              activeUnit,
              workEntryId,
              onRetryUnit,
              handlers,
              chrome.language
            )}
            <ChapterPager
              activeUnitIndex={activeUnitIndex}
              onSelectUnit={onSelectUnit}
              structure={structure}
            />
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

// The active unit's content area: an empty work shows a placeholder; otherwise the active unit's
// blocks load on demand — a spinner while fetching, an alert with a Retry while errored, and the
// rendered unit once its blocks arrive.
function renderActiveUnit(
  structure: ReaderStructure,
  activeUnit: ActiveUnit,
  workEntryId: string,
  onRetryUnit: () => void,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
  if (structure.units.length === 0) {
    return <p>This work has no content yet.</p>;
  }

  switch (activeUnit.status) {
    case "loading":
      return <LoadingIndicator label="Loading this section…" />;
    case "error":
      return (
        <div className="readerUnitError" role="alert">
          <p>Could not load this section. Please try again.</p>
          <button className="readerRetry" onClick={onRetryUnit} type="button">
            Retry
          </button>
        </div>
      );
    case "loaded":
      return renderReaderView(activeUnit.unit, workEntryId, handlers, language);
  }
}

function renderReaderView(
  unit: ReaderUnit,
  workEntryId: string,
  handlers: ReaderHandlers,
  language: string
): React.JSX.Element {
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
  onOpenBlockNotes: (blockEntryId: string, workEntryId: string, noteEntryId?: string) => void;
  prefersReducedMotion: boolean;
  workEntryId: string;
}>;

// A figure block renders as a real `<figure>`: the stored image (served by #101 at
// `/api/images/:id`, lazy-loaded and display-only) above its caption. The image degrades out —
// leaving the caption alone — when there is no stored image (unsupported/missing at ingest) or it
// fails to load at runtime. The caption keeps the block's mdast/plaintext, so it stays selectable
// and annotatable through the normal block selection flow; the image carries no text.
function ReaderFigure({
  block,
  marks
}: {
  block: ReaderBlock;
  marks: ReadonlyArray<NoteMark>;
}): React.JSX.Element {
  const [imageFailed, setImageFailed] = useState(false);
  const imageSrc =
    block.imageResourceId === undefined ? undefined : `/api/images/${block.imageResourceId}`;
  const showImage = imageSrc !== undefined && !imageFailed;
  const hasCaption = block.plaintext.trim().length > 0;

  return (
    <figure className="readerFigure">
      {showImage ? (
        <img
          alt={block.alt ?? ""}
          className="readerFigureImage"
          draggable={false}
          loading="lazy"
          onError={() => setImageFailed(true)}
          src={imageSrc}
        />
      ) : null}
      {hasCaption ? (
        <figcaption className="readerFigureCaption">
          <BlockContent marks={marks} node={block.mdast} />
        </figcaption>
      ) : null}
    </figure>
  );
}

// Map a block's sub-block notes (those with an offset range) to underline marks in the template
// hue. Whole-block notes (no offsets) are excluded — they show the gutter bar instead.
function blockNoteMarks(blockNotes: ReadonlyArray<NoteDto>): ReadonlyArray<NoteMark> {
  return blockNotes
    .filter((note) => note.anchor.startOffset !== undefined && note.anchor.endOffset !== undefined)
    .map((note) => ({
      ariaLabel: `Note on '${note.anchor.selectedTextSnapshot}'`,
      className: noteMarkHueClass(note.templateId),
      endOffset: note.anchor.endOffset as number,
      noteId: note.entryId,
      startOffset: note.anchor.startOffset as number
    }));
}

// One rendered block. Memoized so it re-renders only when its own data/state changes: with
// stable props (memoized handlers, a stable notes array, a per-block `born` flag), opening the
// selection toolbar / lookup / a notes panel or switching a template no longer re-runs the mdast
// rendering for every block in the unit — the cause of the ~500ms handlers. Only the
// born/animating block pays for framer-motion; every other block is a plain element.
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
  const blockNotes = useMemo(() => notesForBlock(notes, block.entryId), [notes, block.entryId]);
  const marks = useMemo(() => blockNoteMarks(blockNotes), [blockNotes]);
  const annotated = blockNotes.length > 0;

  // A whole-block note (no sub-block offsets) gets a restrained hue gutter bar instead of an
  // underline. By the disjoint invariant a block has at most one such note; if legacy data carries
  // more, the first one's hue marks the gutter.
  const wholeBlockNote = blockNotes.find((note) => note.anchor.startOffset === undefined);
  const className =
    wholeBlockNote === undefined
      ? "readerBlock"
      : `readerBlock readerBlock--annotated ${blockGutterHueClass(wholeBlockNote.templateId)}`;

  // Keyboard and touch open the editor too, not just the mouse: a selection inside a
  // focusable block is captured on key-up and touch-end as well as mouse-up.
  const capture = (event: React.SyntheticEvent<HTMLElement>): void =>
    onCaptureSelection(event.currentTarget, block, workEntryId, language);

  // Activating an underline opens *that* note (resolved from the mark's `data-note-id`), not the
  // whole block's notes. A plain tap (collapsed selection) on the underline span — or Enter/Space
  // while it is focused — opens it; a drag-selection that happens to end on an underline still
  // becomes a new selection, so creation is never hijacked.
  const openNoteFrom = (target: EventTarget): boolean => {
    const mark = (target as Element).closest(".noteMark");

    if (mark === null) {
      return false;
    }

    onOpenBlockNotes(block.entryId, workEntryId, mark.getAttribute("data-note-id") as string);
    return true;
  };

  const onClickBlock = (event: React.MouseEvent<HTMLElement>): void => {
    const selection = window.getSelection();

    if (selection !== null && !selection.isCollapsed && selection.toString().length > 0) {
      return;
    }

    openNoteFrom(event.target);
  };

  const onKeyDownBlock = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    if (openNoteFrom(event.target)) {
      event.preventDefault();
    }
  };

  const body = (
    <>
      {block.blockType === "figure" ? (
        <ReaderFigure block={block} marks={marks} />
      ) : (
        <BlockContent marks={marks} node={block.mdast} />
      )}
      {wholeBlockNote === undefined ? null : (
        <button
          className="readerBlockNotes"
          onClick={() => onOpenBlockNotes(block.entryId, workEntryId)}
          onMouseUp={(event) => event.stopPropagation()}
          type="button"
        >
          View note
        </button>
      )}
    </>
  );

  const commonProps = {
    className,
    "data-block-id": block.entryId,
    "data-born": born ? "true" : undefined,
    "data-has-notes": annotated ? "true" : undefined,
    onClick: onClickBlock,
    onKeyDown: onKeyDownBlock,
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
    // A block panel reopened from a single note's underline shows just that note; the whole-block
    // "View note" affordance opens with no `noteEntryId`, listing every note on the block.
    const blockNotes = notesForBlock(notes, panel.blockEntryId);
    const shown =
      panel.noteEntryId === undefined
        ? blockNotes
        : blockNotes.filter((note) => note.entryId === panel.noteEntryId);

    return (
      <aside aria-label="Block notes" className="readerBlockNotesPanel">
        <h2>Notes on this selection</h2>
        <NoteList
          emptyLabel="This block has no notes."
          notes={shown}
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
