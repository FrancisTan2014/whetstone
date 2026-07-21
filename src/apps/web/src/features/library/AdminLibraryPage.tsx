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
import { ingestMarkdown, ingestPdf } from "../content/contentApi";
import { markdownEmptyContentMessage } from "../content/contentMessages";
import {
  createWork,
  deleteWork,
  fetchWorks,
  fetchWorksWithReadingPosition,
  ingestEpub
} from "./libraryApi";
import { AuthorSelectField } from "./AuthorSelectField";
import { groupWorksByAuthor, type AuthorWorks } from "./groupWorksByAuthor";
import { LibraryAddMenu } from "./LibraryAddMenu";
import { WorkOverflowMenu } from "./WorkOverflowMenu";
import { enrollRecitation, listRecitationPlans } from "../recitation/recitationApi";

// Shown when the doc-AI worker could not read an uploaded PDF (the server's 422 `invalid_pdf`), e.g. a
// scanned or corrupt file — mirrors the Manage-content panel's copy so the one front door reads the same.
const invalidPdfMessage = "We couldn’t read this PDF. Please try a different file.";

// Shown when the host has no PDF toolchain provisioned (the server's 503 `pdf_toolchain_missing`) —
// a setup gap, not a bad file, so the copy points at the fix rather than blaming the PDF (#510).
const pdfToolchainMissingMessage =
  "PDF ingestion isn’t set up on the server yet. Run `pnpm setup:pdf` (or `pnpm setup:doctor` to check), then try again.";

// Shown when a PDF produced no readable blocks (the server's 422 `empty_content`), e.g. a
// scanned/image-only PDF — v0 has no image block, so there is nothing to add. The Markdown upload lane
// uses `markdownEmptyContentMessage` so it reads identically to the Manage-content panel (#673).
const emptyPdfContentMessage =
  "This document has no readable text to add. Images on their own aren’t supported yet.";

// Rejects a picked file that is none of the three supported document types before any ingest call.
const unsupportedUploadMessage = "Choose an .epub, .pdf, or .md file.";

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
  const [workError, setWorkError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  // A held PDF/Markdown file waiting for the confirm sheet: unlike an EPUB (OPF metadata is
  // authoritative), these carry no reliable metadata, so we create the Work from the confirmed form
  // first, then ingest this file into it.
  const [pendingUpload, setPendingUpload] = useState<File | undefined>(undefined);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadKind, setUploadKind] = useState<UploadKind | undefined>(undefined);

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
      // The learner's create intent decides the Work's content authority (#695): a plain manual entry is
      // `manual` (owned, editable from the Library), while a held file is an `imported` shell that
      // ingestion then fills. The server stamps origin (and, for manual, the ownership facet); the client
      // only declares which path this is.
      const origin = heldUpload === undefined ? "manual" : "imported";
      const created = await createWork({ author, language, origin, title: trimmedTitle, workType });
      resetWorkForm();
      setPendingUpload(undefined);
      setAddOpen(false);

      if (heldUpload === undefined) {
        await reload();
        toast.success(`Added “${trimmedTitle}”.`);
        // A manual Work is created with a canonical empty document (#720): open it straight in the
        // Library's manual editor to start writing, rather than the imported-content panel.
        navigate(`/library/works/${encodeURIComponent(created.work.entryId)}/edit`);
        return;
      }

      // The Work now exists; ingest the held file into it. `ingestUploadIntoWork` owns its own
      // failure handling (a failed ingest leaves the empty Work in place, retryable from Manage
      // content), so it never throws back into this create-scoped catch.
      await ingestUploadIntoWork(heldUpload, created.work.entryId, trimmedTitle);
    } catch {
      toast.error("Could not save the work. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function ingestUploadIntoWork(
    file: File,
    workEntryId: string,
    workTitle: string
  ): Promise<void> {
    const pdf = detectUploadKind(file) === "pdf";
    setUploadBusy(true);
    setUploadKind(pdf ? "pdf" : "markdown");

    try {
      const failureMessage = await ingestHeldFile(pdf, file, workEntryId);

      if (failureMessage === undefined) {
        toast.success(`Imported “${workTitle}”.`);
      } else {
        toast.error(failureMessage);
      }
    } catch {
      toast.error("Could not ingest the file. Please try again.");
    } finally {
      // The Work was created regardless of the ingest outcome. Refresh the shelf and hand the user to
      // Manage content either way, so a failed ingest leaves the new (empty) Work visible and
      // immediately retryable from that surface.
      await reload();
      onManageContent(workEntryId);
      setUploadBusy(false);
      setUploadKind(undefined);
    }
  }

  // Ingest the held PDF/Markdown into the just-created Work, returning a user-facing message when the
  // server reports a handled failure (unreadable PDF, no readable text) or `undefined` on success.
  async function ingestHeldFile(
    pdf: boolean,
    file: File,
    workEntryId: string
  ): Promise<string | undefined> {
    if (pdf) {
      const outcome = await ingestPdf(workEntryId, file);

      if (outcome.status === "invalid_pdf") {
        return invalidPdfMessage;
      }

      if (outcome.status === "pdf_toolchain_missing") {
        return pdfToolchainMissingMessage;
      }

      if (outcome.status === "empty_content") {
        return emptyPdfContentMessage;
      }

      return undefined;
    }

    const outcome = await ingestMarkdown(workEntryId, {
      fileName: file.name,
      kind: "upload",
      markdown: await file.text()
    });

    if (outcome.status === "empty_content") {
      return markdownEmptyContentMessage;
    }

    return undefined;
  }

  async function onSelectUpload(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (file === undefined) {
      return;
    }

    // EPUB metadata (OPF) is authoritative, so ingest straight to a new Work with no confirm form.
    const kind = detectUploadKind(file);

    if (kind === "epub") {
      setUploadBusy(true);
      setUploadKind("epub");

      try {
        const result = await ingestEpub(file);
        await reload();
        toast.success(`Imported “${result.work.title}”.`);
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
        {uploadKind === "pdf" ? <LoadingIndicator label="Converting the PDF…" /> : null}

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

              <AuthorSelectField onSelectionChange={setAuthorSelection} />

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
