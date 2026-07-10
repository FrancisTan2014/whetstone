import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { motion, type Variants } from "framer-motion";

import type { AuthorDto, CreateWorkRequest, WorkListItemDto } from "@whetstone/contracts";
import {
  toAuthorId,
  workLanguageLabels,
  workLanguages,
  workTypes,
  type WorkLanguage,
  type WorkType
} from "@whetstone/domain";

import { Button, buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { Sheet } from "../../shared/ui/Sheet";
import { Spinner } from "../../shared/ui/Spinner";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";
import { useToast } from "../../shared/ui/toast/ToastProvider";
import { apiUrl } from "../../shared/runtime";
import { detectUploadKind, stripFileExtension } from "../../shared/files/fileType";
import { ingestMarkdown, ingestPdf } from "../content/contentApi";
import {
  createWork,
  deleteWork,
  fetchAuthors,
  fetchWorks,
  fetchWorksWithReadingPosition,
  ingestEpub
} from "./libraryApi";
import { groupWorksByAuthor, type AuthorWorks } from "./groupWorksByAuthor";
import { createAuthoredWork, listAuthoredWorks } from "../authoredWorks/authoredWorkApi";

const newAuthorOption = "new-author-or-source";

// Shown when the doc-AI worker could not read an uploaded PDF (the server's 422 `invalid_pdf`), e.g. a
// scanned or corrupt file — mirrors the Manage-content panel's copy so the one front door reads the same.
const invalidPdfMessage = "We couldn’t read this PDF. Please try a different file.";

// Shown when the host has no PDF toolchain provisioned (the server's 503 `pdf_toolchain_missing`) —
// a setup gap, not a bad file, so the copy points at the fix rather than blaming the PDF (#510).
const pdfToolchainMissingMessage =
  "PDF ingestion isn’t set up on the server yet. Run `pnpm setup:pdf` (or `pnpm setup:doctor` to check), then try again.";

// Shown when a PDF/Markdown produced no readable blocks (the server's 422 `empty_content`), e.g. an
// image-only document — v0 has no image block, so there is nothing to add.
const emptyContentMessage =
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
  const [authors, setAuthors] = useState<ReadonlyArray<AuthorDto>>([]);
  const [works, setWorks] = useState<ReadonlyArray<WorkListItemDto>>([]);
  const [worksWithPosition, setWorksWithPosition] = useState<ReadonlySet<string>>(new Set());
  // Which works are user-authored documents (vs imported sources), so the shelf can badge them and route
  // them to the editor instead of the reader — one library, no separate silo (#576).
  const [authoredWorkIds, setAuthoredWorkIds] = useState<ReadonlySet<string>>(new Set());

  const [addOpen, setAddOpen] = useState(false);
  const [newDocOpen, setNewDocOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<WorkLanguage>("en");
  const [workType, setWorkType] = useState<WorkType>("book");
  const [authorChoice, setAuthorChoice] = useState<string>(newAuthorOption);
  const [inlineAuthorName, setInlineAuthorName] = useState("");
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

  async function reload(): Promise<void> {
    const [authorList, workList, withPosition, authored] = await Promise.all([
      fetchAuthors(),
      fetchWorks(),
      fetchWorksWithReadingPosition(),
      listAuthoredWorks()
    ]);
    setAuthors(authorList.authors);
    setWorks(workList.works);
    setWorksWithPosition(withPosition);
    setAuthoredWorkIds(new Set(authored.works.map((work) => work.entryId)));
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

  function buildAuthorSelection(): CreateWorkRequest["author"] | undefined {
    if (authorChoice === newAuthorOption) {
      const trimmed = inlineAuthorName.trim();

      return trimmed.length === 0 ? undefined : { mode: "new", name: trimmed };
    }

    return { authorId: toAuthorId(authorChoice), mode: "existing" };
  }

  function resetWorkForm(): void {
    setTitle("");
    setLanguage("en");
    setWorkType("book");
    setAuthorChoice(newAuthorOption);
    setInlineAuthorName("");
    setWorkError(undefined);
  }

  // The "Add work" button opens a clean, purely-manual sheet: clearing any held upload guarantees a
  // stray earlier file selection can never be ingested into a manually created work.
  function openManualAddWork(): void {
    setPendingUpload(undefined);
    resetWorkForm();
    setAddOpen(true);
  }

  // "New document" opens a minimal sheet (title, language, type only — the current user is the author) to
  // create an owned Work, then jumps straight into the editor (#576).
  function openNewDocument(): void {
    resetWorkForm();
    setNewDocOpen(true);
  }

  async function onSubmitNewDocument(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedTitle = title.trim();

    if (trimmedTitle.length === 0) {
      setWorkError("Enter a document title.");
      return;
    }

    setSubmitting(true);

    try {
      const created = await createAuthoredWork({ language, title: trimmedTitle, workType });
      resetWorkForm();
      setNewDocOpen(false);
      // Hash routing: open the immersive editor for the new document (mirrors the reader deep links).
      window.location.hash = `#/write?work=${encodeURIComponent(created.entryId)}`;
    } catch {
      toast.error("Could not create the document. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  // The sheet is only rendered while open, and Radix only calls onOpenChange to request dismissal
  // (Esc / overlay / close button), so any change closes it and drops any held upload — mirroring the
  // Library composition's own sheet-dismissal pattern.
  function onSheetDismiss(): void {
    setPendingUpload(undefined);
    setAddOpen(false);
  }

  async function onSubmitWork(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmedTitle = title.trim();

    if (trimmedTitle.length === 0) {
      setWorkError("Enter a work title.");
      return;
    }

    const author = buildAuthorSelection();

    if (author === undefined) {
      setWorkError("Select an existing author or source, or name a new one.");
      return;
    }

    const heldUpload = pendingUpload;
    setSubmitting(true);

    try {
      const created = await createWork({ author, language, title: trimmedTitle, workType });
      resetWorkForm();
      setPendingUpload(undefined);
      setAddOpen(false);

      if (heldUpload === undefined) {
        await reload();
        toast.success(`Added “${trimmedTitle}”.`);
        onManageContent(created.work.entryId);
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
        return emptyContentMessage;
      }

      return undefined;
    }

    const outcome = await ingestMarkdown(workEntryId, {
      fileName: file.name,
      kind: "upload",
      markdown: await file.text()
    });

    if (outcome.status === "empty_content") {
      return emptyContentMessage;
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
    <main className="mx-auto max-w-5xl p-4">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold text-text">Library</h1>
        <div className="flex flex-wrap items-center gap-3">
          <a className={buttonVariants({ variant: "secondary" })} href="#/notes">
            Review all notes
          </a>
          <label
            aria-busy={uploadBusy}
            className={`${buttonVariants({ variant: "secondary" })} cursor-pointer focus-within:ring-2 focus-within:ring-ring focus-within:outline-none ${
              uploadBusy ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {uploadBusy ? <Spinner /> : null}
            Upload
            <input
              accept=".epub,application/epub+zip,.pdf,application/pdf,.md,text/markdown"
              className="sr-only"
              disabled={uploadBusy}
              onChange={(event) => void onSelectUpload(event)}
              type="file"
            />
          </label>
          <Button onClick={openNewDocument} type="button">
            New document
          </Button>
          <Button onClick={openManualAddWork} type="button" variant="secondary">
            Add work
          </Button>
        </div>
      </header>

      {uploadKind === "epub" ? <LoadingIndicator label="Ingesting the EPUB…" /> : null}
      {uploadKind === "pdf" ? <LoadingIndicator label="Converting the PDF…" /> : null}

      {loadState === "loading" ? <LoadingIndicator label="Loading the library…" /> : null}
      {loadState === "error" ? <p role="alert">Could not load the library.</p> : null}

      {loadState === "ready"
        ? renderLibrary(groups, {
            authoredWorkIds,
            cardVariants,
            listVariants,
            onDelete: setPendingDelete,
            onManageContent,
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

            <label className="flex flex-col gap-1" htmlFor="work-author">
              Author or source
              <select
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="work-author"
                onChange={(event) => setAuthorChoice(event.currentTarget.value)}
                value={authorChoice}
              >
                <option value={newAuthorOption}>New author or source…</option>
                {authors.map((author) => (
                  <option key={author.id} value={author.id}>
                    {author.name}
                  </option>
                ))}
              </select>
            </label>

            {authorChoice === newAuthorOption ? (
              <label className="flex flex-col gap-1" htmlFor="inline-author-name">
                New author or source name
                <input
                  className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                  id="inline-author-name"
                  onChange={(event) => setInlineAuthorName(event.currentTarget.value)}
                  value={inlineAuthorName}
                />
              </label>
            ) : null}

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

      {newDocOpen ? (
        <Sheet onOpenChange={() => setNewDocOpen(false)} open title="New document">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => void onSubmitNewDocument(event)}
          >
            <label className="flex flex-col gap-1" htmlFor="new-doc-title">
              Title
              <input
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="new-doc-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                value={title}
              />
            </label>

            <label className="flex flex-col gap-1" htmlFor="new-doc-type">
              Type
              <select
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="new-doc-type"
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

            <label className="flex flex-col gap-1" htmlFor="new-doc-language">
              Language
              <select
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="new-doc-language"
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

            <Button pending={submitting} type="submit">
              Create and write
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
              Permanently delete <span className="font-semibold">“{pendingDelete.work.title}”</span>{" "}
              and all of its content? This can’t be undone.
            </p>
            <div className="flex flex-wrap justify-end gap-3">
              <Button onClick={() => setPendingDelete(undefined)} type="button" variant="secondary">
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
    </main>
  );
}

type RenderLibraryOptions = Readonly<{
  authoredWorkIds: ReadonlySet<string>;
  cardVariants: Variants;
  listVariants: Variants;
  onDelete: (item: WorkListItemDto) => void;
  onManageContent: (workEntryId: string) => void;
  worksWithPosition: ReadonlySet<string>;
}>;

function renderLibrary(
  groups: ReadonlyArray<AuthorWorks>,
  options: RenderLibraryOptions
): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <p className="rounded border border-border bg-surface p-6 text-text-muted">
        No works yet. Add a work or upload a document to start your library.
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
  // sources without a separate silo (#576).
  const authored = options.authoredWorkIds.has(workEntryId);

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
          <span className="rounded bg-anno-thought-wash px-1.5 py-0.5 text-xs text-accent">
            Authored
          </span>
        ) : null}
      </p>
      <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <a
          className={`${cardActionClass} font-medium`}
          href={`#/reader?work=${encodeURIComponent(workEntryId)}`}
        >
          {resumes ? "Continue" : "Read"}
        </a>
        {authored ? (
          <a className={cardActionClass} href={`#/write?work=${encodeURIComponent(workEntryId)}`}>
            Edit
          </a>
        ) : null}
        {authored ? null : (
          <button
            className={cardActionClass}
            onClick={() => options.onManageContent(workEntryId)}
            type="button"
          >
            Manage content
          </button>
        )}
        <a className={cardActionClass} href={`#/notes?work=${encodeURIComponent(workEntryId)}`}>
          Notes
        </a>
        {authored ? null : (
          <a
            className={cardActionClass}
            download={`${item.work.title}.md`}
            href={apiUrl(`/works/${workEntryId}/content/markdown`)}
          >
            Export Markdown
          </a>
        )}
        <button
          className={`${cardActionClass} text-danger hover:text-danger`}
          onClick={() => options.onDelete(item)}
          type="button"
        >
          Delete
        </button>
      </div>
    </motion.li>
  );
}
