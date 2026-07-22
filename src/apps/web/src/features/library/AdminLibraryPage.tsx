import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { motion, type Variants } from "framer-motion";
import { useNavigate } from "react-router-dom";

import type { CreateWorkRequest, RecitationPlanDto, WorkListItemDto } from "@whetstone/contracts";
import {
  workLanguageLabels,
  workLanguages,
  workTypes,
  type WorkLanguage,
  type WorkType
} from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { PageFrame } from "../../shared/ui/PageFrame";
import { Sheet } from "../../shared/ui/Sheet";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";
import { useToast } from "../../shared/ui/toast/ToastProvider";
import { detectUploadKind, stripFileExtension } from "../../shared/files/fileType";
import { markdownEmptyContentMessage } from "../content/contentMessages";
import { beginPdfImport, cancelPdfImport, fetchPdfImportView } from "../pdfImport/pdfImportApi";
import {
  pollPdfImportUntilTerminal,
  type PdfImportPollResult
} from "../pdfImport/pdfImportPolling";
import {
  forgetActivePdfImport,
  readActivePdfImport,
  rememberActivePdfImport
} from "../pdfImport/pdfImportSession";
import {
  createWork,
  deleteWork,
  fetchWorks,
  fetchWorksWithReadingPosition,
  importMarkdownWork,
  ingestEpub
} from "./libraryApi";
import { AuthorSelectField } from "./AuthorSelectField";
import { groupWorksByAuthor, type AuthorWorks } from "./groupWorksByAuthor";
import { LibraryAddMenu } from "./LibraryAddMenu";
import { WorkOverflowMenu } from "./WorkOverflowMenu";
import { enrollRecitation, listRecitationPlans } from "../recitation/recitationApi";

// Shown when a picked file is none of the three supported document types, before any ingest call.
const unsupportedUploadMessage = "Choose an .epub, .pdf, or .md file.";

// How often the Library polls an in-flight born-digital PDF import's view (#702). The server job runs
// independently; this only paces the progress card. One second keeps the card responsive without hammering.
const pdfImportPollIntervalMs = 1000;

type LoadState = "loading" | "ready" | "error";

// Which document is ingesting, so the header can show the right progress copy: EPUB ingests on
// selection; PDF/Markdown ingest after the confirm sheet is submitted.
type UploadKind = "epub" | "pdf" | "markdown";

function formatWorkType(workType: WorkType): string {
  return workType.replace("_", " ");
}

function workCountLabel(count: number): string {
  return count === 1 ? "1 work" : `${count} works`;
}

type AdminLibraryPageProps = Readonly<{
  // Opening a work's focused content-management surface (manual Markdown + `.md` upload) is owned by
  // the app-level Library composition, so the shelf stays a calm list and only emits the intent.
  onManageContent: (workEntryId: string) => void;
}>;

export function AdminLibraryPage({ onManageContent }: AdminLibraryPageProps): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [works, setWorks] = useState<ReadonlyArray<WorkListItemDto>>([]);
  const [worksWithPosition, setWorksWithPosition] = useState<ReadonlySet<string>>(new Set());
  // The learner's recitation plans keyed by source Work: a Work already enrolled offers **Open in
  // Recite** in overflow, an un-enrolled one offers **I can recite this** (#643) — a Work enrolls once.
  // Library shows no recitation status/phase/due; Recite owns all maintenance state (#640).
  const [recitationByWork, setRecitationByWork] = useState<ReadonlyMap<string, RecitationPlanDto>>(
    new Map()
  );
  // The Work whose enrollment is in flight (its entry id), so its "I can recite this" action shows a
  // pending spinner and can't be double-submitted while the plan is being created.
  const [enrollingWorkId, setEnrollingWorkId] = useState<string | undefined>(undefined);

  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<WorkLanguage>("en");
  const [workType, setWorkType] = useState<WorkType>("book");
  const [authorSelection, setAuthorSelection] = useState<CreateWorkRequest["author"] | undefined>(
    undefined
  );
  // The resolved display name for the chosen author, reported by AuthorSelectField alongside the
  // selection. The born-digital import resolves its author by name (#702), so the page forwards this name
  // rather than re-deriving it from the selection (an existing pick carries only an id, not a name).
  const [authorName, setAuthorName] = useState<string | undefined>(undefined);
  const [workError, setWorkError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // A held PDF/Markdown file waiting for the confirm sheet: unlike an EPUB (OPF metadata is
  // authoritative), these carry no reliable metadata, so we create the Work from the confirmed form
  // first, then ingest this file into it.
  const [pendingUpload, setPendingUpload] = useState<File | undefined>(undefined);

  // A born-digital import (#702) left in flight when the page was last closed or navigated away is remembered
  // by its #721 attempt id; reading it once on mount (lazy initial state, never in an effect) re-enters the
  // poll loop below so the progress card reappears and completion still opens the Reader.
  const [rememberedPdfImportId] = useState(() => readActivePdfImport());
  const [uploadBusy, setUploadBusy] = useState(() => rememberedPdfImportId !== null);
  const [uploadKind, setUploadKind] = useState<UploadKind | undefined>(() =>
    rememberedPdfImportId !== null ? "pdf" : undefined
  );

  // The born-digital PDF import currently being polled (its #721 attempt id) and the label to show while
  // it runs. Undefined when no import is in flight. Held in state (not a ref) so the progress card and the
  // poll effect react to it, and so a remembered attempt can resume the loop after navigation.
  const [activePdfImportId, setActivePdfImportId] = useState<string | undefined>(
    () => rememberedPdfImportId ?? undefined
  );
  const [pdfImportLabel, setPdfImportLabel] = useState<string | undefined>(() =>
    rememberedPdfImportId !== null ? "Resuming the import…" : undefined
  );

  // The work awaiting an explicit delete confirmation (destructive + irreversible), and whether the
  // confirmed delete is in flight, so the confirm dialog names the work and disables while deleting.
  const [pendingDelete, setPendingDelete] = useState<WorkListItemDto | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);

  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const toast = useToast();
  const navigate = useNavigate();
  // The single hidden file input behind the header's "Upload file" action — the one front door for
  // .epub/.pdf/.md. The Add menu item clicks it to open the OS picker; `onSelectUpload` then routes the
  // chosen file into the existing ingest flow.
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function reload(): Promise<void> {
    const [workList, withPosition, recitation] = await Promise.all([
      fetchWorks(),
      fetchWorksWithReadingPosition(),
      listRecitationPlans()
    ]);
    setWorks(workList.works);
    setWorksWithPosition(withPosition);
    setRecitationByWork(new Map(recitation.plans.map((plan) => [plan.workEntryId, plan])));
  }

  // Open a published (or reopened) Work in the existing Reader. HashRouter renders this as
  // `#/reader?work=<id>`, matching the Library's own read links.
  function openReader(workEntryId: string): void {
    navigate(`/reader?work=${encodeURIComponent(workEntryId)}`);
  }

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        await reload();
        setLoadState("ready");
      } catch {
        setLoadState("error");
      }
    }

    void load();
  }, []);

  function resetWorkForm(): void {
    setTitle("");
    setLanguage("en");
    setWorkType("book");
    setAuthorSelection(undefined);
    setAuthorName(undefined);
    setWorkError(undefined);
  }

  // The "Add work" button opens a clean, purely-manual sheet: clearing any held upload guarantees a
  // stray earlier file selection can never be ingested into a manually created work.
  function openManualAddWork(): void {
    setPendingUpload(undefined);
    resetWorkForm();
    setAddOpen(true);
  }

  // The sheet is only rendered while open, and Radix only calls onOpenChange to request dismissal
  // (Esc / overlay / close button), so any change closes it and drops any held upload — mirroring the
  // Library composition's own sheet-dismissal pattern.
  function onSheetDismiss(): void {
    setPendingUpload(undefined);
    setAddOpen(false);
  }

  // "I can recite this" enrolls the exact Work into direct Recitation maintenance (#643): the learner's
  // explicit declaration that the Work is retrievable. Enrollment persists BEFORE the first review opens
  // (and is idempotent — re-clicking never duplicates the plan), then we navigate to the Work's whole-Work
  // review. Learning and maintenance are separate — there is no phase choice.
  async function enrollWork(item: WorkListItemDto): Promise<void> {
    const workEntryId = item.work.entryId;
    setEnrollingWorkId(workEntryId);
    try {
      await enrollRecitation(workEntryId);
      await reload();
      navigate(`/recitation?work=${encodeURIComponent(workEntryId)}`);
    } catch {
      toast.error("Could not start reciting this work. Please try again.");
    } finally {
      setEnrollingWorkId(undefined);
    }
  }

  async function onSubmitWork(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedTitle = title.trim();

    if (trimmedTitle.length === 0) {
      setWorkError("Enter a work title.");
      return;
    }

    const author = authorSelection;

    if (author === undefined) {
      setWorkError("Select an existing author or source, or name a new one.");
      return;
    }

    const heldUpload = pendingUpload;
    setSubmitting(true);

    try {
      // Three create lanes by intent (#695): a plain manual entry mints an owned, editable Work; a held
      // Markdown or PDF file mints an imported Work through its own atomic front door. The server stamps
      // origin and provenance; the client only routes to the right lane.

      // A held Markdown file mints its imported Work atomically through the front-door import endpoint
      // (#706): the Work, its source, and its single-owner claim are written in one transaction, so
      // re-uploading identical bytes reopens the existing Work instead of leaving an orphan shell.
      if (heldUpload !== undefined && detectUploadKind(heldUpload) === "markdown") {
        resetWorkForm();
        setPendingUpload(undefined);
        setAddOpen(false);
        await importHeldMarkdown(heldUpload, author, trimmedTitle);
        return;
      }

      // A plain manual entry mints an owned, editable Work with a canonical empty document (#720).
      if (heldUpload === undefined) {
        const created = await createWork({
          author,
          language,
          origin: "manual",
          title: trimmedTitle,
          workType
        });
        resetWorkForm();
        setPendingUpload(undefined);
        setAddOpen(false);
        await reload();
        toast.success(`Added “${trimmedTitle}”.`);
        // A manual Work is created with a canonical empty document (#720): open it straight in the
        // Library's manual editor to start writing, rather than the imported-content panel.
        navigate(`/library/works/${encodeURIComponent(created.work.entryId)}/edit`);
        return;
      }

      // A held PDF is a born-digital import (#702): no shell Work is created up front. The import runs as a
      // #721 staged attempt and, on completion, mints its Author -> Work -> ReadingUnit -> Block canonical
      // Work atomically (identical bytes reopen the existing Work instead, #706). This lane owns its own
      // progress and failure surfacing, so it never throws back into this create-scoped catch.
      resetWorkForm();
      setPendingUpload(undefined);
      setAddOpen(false);
      await beginHeldPdfImport(heldUpload, trimmedTitle, authorName, language);
    } catch {
      toast.error("Could not save the work. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // Start a born-digital PDF import from the held file (#702). Identical bytes reopen the existing Work and
  // open the Reader (#706); otherwise a staged attempt is queued and its id remembered so an in-flight
  // import survives navigation and can be resumed. This lane owns its own progress and failure surfacing.
  async function beginHeldPdfImport(
    file: File,
    workTitle: string,
    enteredAuthor: string | undefined,
    workLanguage: WorkLanguage
  ): Promise<void> {
    setUploadBusy(true);
    setUploadKind("pdf");
    setPdfImportLabel("Uploading the PDF…");

    try {
      const result = await beginPdfImport(file, {
        /* v8 ignore next -- AuthorSelectField always reports a resolved name alongside a defined
           selection, and submit is blocked when the selection is undefined, so `enteredAuthor` is
           always a string here; the null fallback only bridges the optional-name type. */
        enteredAuthor: enteredAuthor ?? null,
        enteredLanguage: workLanguage,
        enteredTitle: workTitle,
        fileName: file.name
      });

      if (result.outcome === "reopened") {
        finishPdfImport();
        await reload();
        toast.success(`“${workTitle}” is already in your library — opening it.`);
        openReader(result.workEntryId);
        return;
      }

      rememberActivePdfImport(result.attemptId);
      setActivePdfImportId(result.attemptId);
    } catch {
      finishPdfImport();
      toast.error("Could not start the import. Please try again.");
    }
  }

  // Clear every in-flight import UI signal and drop the remembered attempt so no stale poll resumes it.
  function finishPdfImport(): void {
    forgetActivePdfImport();
    setActivePdfImportId(undefined);
    setPdfImportLabel(undefined);
    setUploadBusy(false);
    setUploadKind(undefined);
  }

  // Cancel the in-flight import: the server terminates its owned conversion child and drops the stage. We
  // stop the local poll ourselves rather than waiting for the cancelled state to propagate through a poll.
  async function cancelActivePdfImport(): Promise<void> {
    const attemptId = activePdfImportId;
    /* v8 ignore next 3 -- defensive: the Cancel button only renders while an import is in flight
       (activePdfImportId defined), so this guard cannot be reached through the rendered UI. */
    if (attemptId === undefined) {
      return;
    }
    finishPdfImport();
    try {
      await cancelPdfImport(attemptId);
    } catch {
      // The local session is already cleared; a failed cancel only leaves the server job to finish on its
      // own (reopenable later), so there is nothing to surface here.
    }
    toast.success("Import cancelled.");
  }

  // Apply a terminal poll outcome (#702): open the Reader on a published Work, or surface the
  // sequenced-limitation (OCR) or named-failure copy. `gone` means the remembered attempt no longer exists
  // for this user (a stale reopened id), so we simply drop it.
  async function applyPdfImportTerminal(result: PdfImportPollResult): Promise<void> {
    if (result.kind !== "terminal") {
      // `gone` (a stale reopened id) or a late `aborted`: no Work to open, just drop the session.
      finishPdfImport();
      return;
    }

    const { progress } = result;
    finishPdfImport();

    if (progress.kind === "published") {
      await reload();
      toast.success("Your PDF is ready to read.");
      openReader(progress.workEntryId);
      return;
    }

    /* v8 ignore next 3 -- a terminal poll result is published, ocr_required, or failed; `in_progress`
       (the only remaining kind) is never terminal, so this early return is unreachable. */
    if (progress.kind !== "ocr_required" && progress.kind !== "failed") {
      return;
    }

    // ocr_required and failed both surface their message and create no Work.
    toast.error(progress.message);
  }

  // Drive the poll loop for the in-flight born-digital import (#702). Setting `activePdfImportId` — a fresh
  // queued attempt, or a remembered one resumed on mount — starts it; navigating away aborts the local loop
  // (the server job keeps running and can be reopened). The first poll reports progress immediately, so the
  // card never shows a stale label. Declared after `applyPdfImportTerminal` so the effect never reads it
  // before it exists.
  useEffect(() => {
    const attemptId = activePdfImportId;
    if (attemptId === undefined) {
      return;
    }

    let aborted = false;
    void (async () => {
      const result = await pollPdfImportUntilTerminal(
        attemptId,
        (progress) => {
          if (!aborted && progress.kind === "in_progress") {
            setPdfImportLabel(progress.label);
          }
        },
        {
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          fetchView: fetchPdfImportView,
          intervalMs: pdfImportPollIntervalMs
        },
        () => aborted
      );

      if (aborted || result.kind === "aborted") {
        return;
      }
      await applyPdfImportTerminal(result);
    })();

    return () => {
      aborted = true;
    };
    // Only the attempt id drives (re)starting the loop; the handlers it closes over are stable enough for
    // this effect and re-running on every render would restart polling needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePdfImportId]);

  // Mint an imported Work from the held Markdown file in one atomic request (#706). Re-uploading
  // identical bytes reopens the existing Work instead of creating a duplicate; either way the learner
  // lands in Manage content. Markdown with no readable blocks creates no Work and shows the panel's copy.
  async function importHeldMarkdown(
    file: File,
    author: CreateWorkRequest["author"],
    workTitle: string
  ): Promise<void> {
    setUploadBusy(true);
    setUploadKind("markdown");

    try {
      const outcome = await importMarkdownWork({
        author,
        fileName: file.name,
        language,
        markdown: await file.text(),
        title: workTitle,
        workType
      });

      if (outcome.status === "empty_content") {
        await reload();
        toast.error(markdownEmptyContentMessage);
        return;
      }

      await reload();
      toast.success(
        outcome.status === "exact_existing"
          ? `“${outcome.result.work.title}” is already in your library — opened it.`
          : `Imported “${workTitle}”.`
      );
      onManageContent(outcome.result.work.entryId);
    } catch {
      toast.error("Could not ingest the file. Please try again.");
    } finally {
      setUploadBusy(false);
      setUploadKind(undefined);
    }
  }

  async function onSelectUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (file === undefined) {
      return;
    }

    // EPUB metadata (OPF) is authoritative, so ingest straight to a new Work with no confirm form. A
    // re-upload of identical bytes reopens the owning Work (#706): the learner is told it is already in
    // the library and dropped into Manage content, mirroring the Markdown front door.
    const kind = detectUploadKind(file);

    if (kind === "epub") {
      setUploadBusy(true);
      setUploadKind("epub");

      try {
        const outcome = await ingestEpub(file);
        await reload();

        if (outcome.status === "exact_existing") {
          toast.success(`“${outcome.result.work.title}” is already in your library — opened it.`);
          onManageContent(outcome.result.work.entryId);
        } else {
          toast.success(`Imported “${outcome.result.work.title}”.`);
        }
      } catch {
        toast.error("Could not ingest the EPUB. Please try again.");
      } finally {
        setUploadBusy(false);
        setUploadKind(undefined);
      }

      return;
    }

    // PDF/Markdown carry no reliable metadata: hold the file and confirm the Work first, pre-filling
    // the title from the filename.
    if (kind === "pdf" || kind === "markdown") {
      resetWorkForm();
      setPendingUpload(file);
      setTitle(stripFileExtension(file.name));
      setAddOpen(true);
      return;
    }

    toast.error(unsupportedUploadMessage);
  }

  // The confirmed delete: remove the work, refresh the shelf, and close the dialog. A failure keeps the
  // work and surfaces a toast; the confirm step (naming the work) is the guard for this irreversible act.
  async function onConfirmDelete(target: WorkListItemDto): Promise<void> {
    setDeleting(true);

    try {
      await deleteWork(target.work.entryId);
      setPendingDelete(undefined);
      await reload();
      toast.success(`Deleted “${target.work.title}”.`);
    } catch {
      toast.error("Could not delete the work. Please try again.");
    } finally {
      setDeleting(false);
    }
  }

  const listVariants: Variants = {
    hidden: {},
    visible: { transition: { staggerChildren: prefersReducedMotion ? 0 : 0.05 } }
  };
  const cardVariants: Variants = prefersReducedMotion
    ? { hidden: { opacity: 1 }, visible: { opacity: 1 } }
    : { hidden: { opacity: 0, y: 8 }, visible: { opacity: 1, y: 0 } };

  const groups = groupWorksByAuthor(works);

  // The in-flight PDF progress card's label. A PDF import always carries a label (set on start, on
  // resume, and on every in-progress poll tick), so the fallback is only a defensive default.
  const pdfProgressLabel = pdfImportLabel ?? "Importing the PDF…";

  return (
    <PageFrame
      primaryAction={
        <LibraryAddMenu
          busy={uploadBusy}
          onAddWorkManually={openManualAddWork}
          onUploadFile={() => fileInputRef.current?.click()}
        />
      }
      title="Library"
      width="collection"
    >
      <div>
        <input
          accept=".epub,application/epub+zip,.pdf,application/pdf,.md,text/markdown"
          aria-label="Upload"
          className="sr-only"
          onChange={(event) => void onSelectUpload(event)}
          ref={fileInputRef}
          tabIndex={-1}
          type="file"
        />

        {uploadKind === "epub" ? <LoadingIndicator label="Ingesting the EPUB…" /> : null}
        {uploadKind === "pdf" ? (
          <div className="flex items-center justify-between gap-3" role="status">
            <LoadingIndicator label={pdfProgressLabel} />
            {activePdfImportId !== undefined ? (
              <Button
                onClick={() => void cancelActivePdfImport()}
                type="button"
                variant="secondary"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}

        {loadState === "loading" ? <LoadingIndicator label="Loading the library…" /> : null}
        {loadState === "error" ? <p role="alert">Could not load the library.</p> : null}

        {loadState === "ready"
          ? renderLibrary(groups, {
              cardVariants,
              listVariants,
              onDelete: setPendingDelete,
              onManageContent,
              onRecite: (item) => void enrollWork(item),
              enrollingWorkId,
              recitationByWork,
              worksWithPosition
            })
          : null}

        {addOpen ? (
          <Sheet onOpenChange={onSheetDismiss} open title="Add work">
            <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmitWork(event)}>
              <label className="flex flex-col gap-1" htmlFor="work-title">
                Title
                <input
                  className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                  id="work-title"
                  onChange={(event) => setTitle(event.currentTarget.value)}
                  value={title}
                />
              </label>

              <label className="flex flex-col gap-1" htmlFor="work-type">
                Type
                <select
                  className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                  id="work-type"
                  onChange={(event) => setWorkType(event.currentTarget.value as WorkType)}
                  value={workType}
                >
                  {workTypes.map((type) => (
                    <option key={type} value={type}>
                      {formatWorkType(type)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="flex flex-col gap-1" htmlFor="work-language">
                Language
                <select
                  className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                  id="work-language"
                  onChange={(event) => setLanguage(event.currentTarget.value as WorkLanguage)}
                  value={language}
                >
                  {workLanguages.map((code) => (
                    <option key={code} value={code}>
                      {workLanguageLabels[code]}
                    </option>
                  ))}
                </select>
              </label>

              <AuthorSelectField
                onSelectionChange={(selection, name) => {
                  setAuthorSelection(selection);
                  setAuthorName(name);
                }}
              />

              <Button pending={submitting} type="submit">
                Create work
              </Button>
              {workError !== undefined ? (
                <p className="text-danger" role="alert">
                  {workError}
                </p>
              ) : null}
            </form>
          </Sheet>
        ) : null}

        {pendingDelete !== undefined ? (
          <Sheet onOpenChange={() => setPendingDelete(undefined)} open title="Delete work">
            <div className="flex flex-col gap-4">
              <p className="text-text">
                Permanently delete{" "}
                <span className="font-semibold">“{pendingDelete.work.title}”</span> and all of its
                content? This can’t be undone.
              </p>
              <div className="flex flex-wrap justify-end gap-3">
                <Button
                  onClick={() => setPendingDelete(undefined)}
                  type="button"
                  variant="secondary"
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void onConfirmDelete(pendingDelete)}
                  pending={deleting}
                  type="button"
                >
                  Delete work
                </Button>
              </div>
            </div>
          </Sheet>
        ) : null}
      </div>
    </PageFrame>
  );
}

type RenderLibraryOptions = Readonly<{
  cardVariants: Variants;
  enrollingWorkId: string | undefined;
  listVariants: Variants;
  onDelete: (item: WorkListItemDto) => void;
  onManageContent: (workEntryId: string) => void;
  onRecite: (item: WorkListItemDto) => void;
  recitationByWork: ReadonlyMap<string, RecitationPlanDto>;
  worksWithPosition: ReadonlySet<string>;
}>;

function renderLibrary(
  groups: ReadonlyArray<AuthorWorks>,
  options: RenderLibraryOptions
): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <p className="rounded border border-border bg-surface p-6 text-text-muted">
        No works yet. Use Add above to upload a file or create your first work.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {groups.map((group) => (
        <section aria-labelledby={`author-${group.author.id}`} key={group.author.id}>
          <h2 className="mb-3 flex items-baseline gap-2 text-xl font-semibold text-text">
            <span id={`author-${group.author.id}`}>{group.author.name}</span>
            <span className="text-sm font-normal text-text-muted">
              {workCountLabel(group.works.length)}
            </span>
          </h2>
          <motion.ul
            animate="visible"
            className="grid gap-3 sm:grid-cols-2"
            initial="hidden"
            variants={options.listVariants}
          >
            {group.works.map((item) => renderWorkCard(item, options))}
          </motion.ul>
        </section>
      ))}
    </div>
  );
}

// Per-work card actions (#463): quiet accent text links/buttons, but each expanded to a >=44px hit
// target in BOTH dimensions (WCAG 2.5.5 / the app's target-size rule) — the labels alone rendered only
// ~20px tall. inline-flex centers the label in the padded, min-sized box; the accent styling is unchanged.
const cardActionClass =
  "inline-flex min-h-11 min-w-11 items-center justify-center px-2 text-accent hover:text-accent-hover";

function renderWorkCard(item: WorkListItemDto, options: RenderLibraryOptions): React.JSX.Element {
  const workEntryId = item.work.entryId;
  // "Continue" only when the reader has a saved position for this work; otherwise a truthful "Read".
  const resumes = options.worksWithPosition.has(workEntryId);
  // Authored documents are first-class in the shared reader: reading opens `#/reader` (selection → note
  // capture, search deep-links, highlights — identical to imported works), while editing opens the full
  // rich editor at `#/write`. They carry a badge so the one shelf distinguishes them from imported
  // sources without a separate silo (#576). Ownership is read straight off the projected `origin` (#695),
  // so the shelf never issues a second ownership request to tell authored Works apart.
  const authored = item.work.origin === "authored";

  return (
    <motion.li
      className="flex flex-col gap-2 rounded border border-border bg-surface p-4"
      key={workEntryId}
      variants={options.cardVariants}
    >
      <h3 className="font-serif text-lg text-text">{item.work.title}</h3>
      <p className="flex items-center gap-2 text-sm text-text-muted">
        <span>
          {formatWorkType(item.work.workType)} · {workLanguageLabels[item.work.language]}
        </span>
        {authored ? (
          <span className="rounded bg-bg px-1.5 py-0.5 text-xs text-text-muted">Authored</span>
        ) : null}
      </p>
      <div className="mt-auto flex items-center justify-between gap-2">
        <a
          className={`${cardActionClass} font-medium`}
          href={`#/reader?work=${encodeURIComponent(workEntryId)}`}
        >
          {resumes ? "Continue" : "Read"}
        </a>
        <WorkOverflowMenu
          enrolled={options.recitationByWork.has(workEntryId)}
          enrolling={options.enrollingWorkId === workEntryId}
          item={item}
          onDelete={() => options.onDelete(item)}
          onManageContent={() => options.onManageContent(workEntryId)}
          onRecite={() => options.onRecite(item)}
        />
      </div>
    </motion.li>
  );
}
