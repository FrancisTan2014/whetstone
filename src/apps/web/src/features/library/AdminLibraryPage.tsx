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
import { Sheet } from "../../shared/ui/Sheet";
import { useToast } from "../../shared/ui/toast/ToastProvider";
import { createWork, fetchAuthors, fetchWorks, ingestEpub } from "./libraryApi";
import { groupWorksByAuthor, type AuthorWorks } from "./groupWorksByAuthor";

const newAuthorOption = "new-author-or-source";

type LoadState = "loading" | "ready" | "error";

function formatWorkType(workType: WorkType): string {
  return workType.replace("_", " ");
}

function workCountLabel(count: number): string {
  return count === 1 ? "1 work" : `${count} works`;
}

export function AdminLibraryPage(): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [authors, setAuthors] = useState<ReadonlyArray<AuthorDto>>([]);
  const [works, setWorks] = useState<ReadonlyArray<WorkListItemDto>>([]);

  const [addOpen, setAddOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<WorkLanguage>("en");
  const [workType, setWorkType] = useState<WorkType>("book");
  const [authorChoice, setAuthorChoice] = useState<string>(newAuthorOption);
  const [inlineAuthorName, setInlineAuthorName] = useState("");
  const [workError, setWorkError] = useState<string | undefined>(undefined);

  const [epubBusy, setEpubBusy] = useState(false);

  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const toast = useToast();

  useEffect(() => {
    setPrefersReducedMotion(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }, []);

  async function reload(): Promise<void> {
    const [authorList, workList] = await Promise.all([fetchAuthors(), fetchWorks()]);
    setAuthors(authorList.authors);
    setWorks(workList.works);
  }

  useEffect(() => {
    reload()
      .then(() => setLoadState("ready"))
      .catch(() => setLoadState("error"));
  }, []);

  function buildAuthorSelection(): CreateWorkRequest["author"] | undefined {
    if (authorChoice === newAuthorOption) {
      const trimmed = inlineAuthorName.trim();

      return trimmed.length === 0 ? undefined : { mode: "new", name: trimmed };
    }

    return { authorId: toAuthorId(authorChoice), mode: "existing" };
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

    try {
      await createWork({ author, language, title: trimmedTitle, workType });
      setTitle("");
      setInlineAuthorName("");
      setWorkError(undefined);
      setAddOpen(false);
      await reload();
      toast.success(`Added “${trimmedTitle}”.`);
    } catch {
      toast.error("Could not save the work. Please try again.");
    }
  }

  async function onUploadEpub(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";

    if (file === undefined) {
      return;
    }

    setEpubBusy(true);

    try {
      const result = await ingestEpub(file);
      await reload();
      toast.success(`Imported “${result.work.title}”.`);
    } catch {
      toast.error("Could not ingest the EPUB. Please try again.");
    } finally {
      setEpubBusy(false);
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
          <label
            className={`${buttonVariants({ variant: "secondary" })} cursor-pointer focus-within:ring-2 focus-within:ring-ring focus-within:outline-none ${
              epubBusy ? "pointer-events-none opacity-50" : ""
            }`}
          >
            Upload EPUB
            <input
              accept=".epub,application/epub+zip"
              className="sr-only"
              disabled={epubBusy}
              onChange={(event) => void onUploadEpub(event)}
              type="file"
            />
          </label>
          <Button onClick={() => setAddOpen(true)} type="button">
            Add work
          </Button>
        </div>
      </header>

      {epubBusy ? <p className="text-text-muted">Ingesting the EPUB…</p> : null}

      {loadState === "loading" ? <p className="text-text-muted">Loading the library…</p> : null}
      {loadState === "error" ? <p role="alert">Could not load the library.</p> : null}

      {loadState === "ready" ? renderLibrary(groups, listVariants, cardVariants) : null}

      {addOpen ? (
        <Sheet onOpenChange={setAddOpen} open title="Add work">
          <form className="flex flex-col gap-3" onSubmit={(event) => void onSubmitWork(event)}>
            <label className="flex flex-col gap-1" htmlFor="work-title">
              Title
              <input
                className="rounded border border-border bg-surface px-3 py-2"
                id="work-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                value={title}
              />
            </label>

            <label className="flex flex-col gap-1" htmlFor="work-type">
              Type
              <select
                className="rounded border border-border bg-surface px-3 py-2"
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
                className="rounded border border-border bg-surface px-3 py-2"
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
                className="rounded border border-border bg-surface px-3 py-2"
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
                  className="rounded border border-border bg-surface px-3 py-2"
                  id="inline-author-name"
                  onChange={(event) => setInlineAuthorName(event.currentTarget.value)}
                  value={inlineAuthorName}
                />
              </label>
            ) : null}

            <Button type="submit">Create work</Button>
            {workError !== undefined ? (
              <p className="text-danger" role="alert">
                {workError}
              </p>
            ) : null}
          </form>
        </Sheet>
      ) : null}
    </main>
  );
}

function renderLibrary(
  groups: ReadonlyArray<AuthorWorks>,
  listVariants: Variants,
  cardVariants: Variants
): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <p className="rounded border border-border bg-surface p-6 text-text-muted">
        No works yet. Add a work or upload an EPUB to start your library.
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
            variants={listVariants}
          >
            {group.works.map((item) => (
              <motion.li
                className="flex flex-col gap-2 rounded border border-border bg-surface p-4"
                key={item.work.entryId}
                variants={cardVariants}
              >
                <h3 className="font-serif text-lg text-text">{item.work.title}</h3>
                <p className="text-sm text-text-muted">
                  {formatWorkType(item.work.workType)} · {workLanguageLabels[item.work.language]}
                </p>
                <div className="mt-auto flex gap-4 text-sm">
                  <a
                    className="text-accent hover:text-accent-hover"
                    href={`#/reader?work=${encodeURIComponent(item.work.entryId)}`}
                  >
                    Continue reading
                  </a>
                  <a
                    className="text-accent hover:text-accent-hover"
                    download={`${item.work.title}.md`}
                    href={`/api/works/${item.work.entryId}/content/markdown`}
                  >
                    Export Markdown
                  </a>
                </div>
              </motion.li>
            ))}
          </motion.ul>
        </section>
      ))}
    </div>
  );
}
