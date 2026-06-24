import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import type { AuthorDto, CreateWorkRequest, WorkListItemDto } from "@whetstone/contracts";
import {
  toAuthorId,
  workLanguageLabels,
  workLanguages,
  workTypes,
  type WorkLanguage,
  type WorkType
} from "@whetstone/domain";

import { createAuthor, createWork, fetchAuthors, fetchWorks, ingestEpub } from "./libraryApi";

const newAuthorOption = "new-author-or-source";

type LoadState = "loading" | "ready" | "error";

function formatWorkType(workType: WorkType): string {
  return workType.replace("_", " ");
}

export function AdminLibraryPage(): React.JSX.Element {
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [authors, setAuthors] = useState<ReadonlyArray<AuthorDto>>([]);
  const [works, setWorks] = useState<ReadonlyArray<WorkListItemDto>>([]);

  const [authorName, setAuthorName] = useState("");
  const [authorError, setAuthorError] = useState<string | undefined>(undefined);

  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<WorkLanguage>("en");
  const [workType, setWorkType] = useState<WorkType>("book");
  const [authorChoice, setAuthorChoice] = useState<string>(newAuthorOption);
  const [inlineAuthorName, setInlineAuthorName] = useState("");
  const [workError, setWorkError] = useState<string | undefined>(undefined);

  const [epubError, setEpubError] = useState<string | undefined>(undefined);
  const [epubBusy, setEpubBusy] = useState(false);

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

  async function onSubmitAuthor(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = authorName.trim();

    if (trimmed.length === 0) {
      setAuthorError("Enter an author or source name.");
      return;
    }

    try {
      const created = await createAuthor({ name: trimmed });
      setAuthorName("");
      setAuthorError(undefined);
      await reload();
      setAuthorChoice(created.id);
    } catch {
      setAuthorError("Could not save the author or source. Please try again.");
    }
  }

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
      await reload();
    } catch {
      setWorkError("Could not save the work. Please try again.");
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
      await ingestEpub(file);
      setEpubError(undefined);
      await reload();
    } catch {
      setEpubError("Could not ingest the EPUB. Please try again.");
    } finally {
      setEpubBusy(false);
    }
  }

  return (
    <main className="appShell">
      <h1>Library admin</h1>

      {loadState === "loading" ? <p>Loading the library…</p> : null}
      {loadState === "error" ? <p role="alert">Could not load the library.</p> : null}

      {loadState === "ready" ? (
        <div className="adminGrid">
          <section aria-labelledby="authors-heading" className="card">
            <h2 id="authors-heading">Authors and sources</h2>
            <form onSubmit={(event) => void onSubmitAuthor(event)}>
              <label htmlFor="author-name">Name</label>
              <input
                id="author-name"
                onChange={(event) => setAuthorName(event.currentTarget.value)}
                value={authorName}
              />
              <button type="submit">Add author or source</button>
              {authorError !== undefined ? <p role="alert">{authorError}</p> : null}
            </form>
            {authors.length === 0 ? (
              <p>No authors or sources yet.</p>
            ) : (
              <ul aria-label="Existing authors and sources">
                {authors.map((author) => (
                  <li key={author.id}>{author.name}</li>
                ))}
              </ul>
            )}
          </section>

          <section aria-labelledby="works-heading" className="card">
            <h2 id="works-heading">Works</h2>

            <div className="epubUpload">
              <label htmlFor="epub-upload">Upload an EPUB</label>
              <input
                accept=".epub,application/epub+zip"
                disabled={epubBusy}
                id="epub-upload"
                onChange={(event) => void onUploadEpub(event)}
                type="file"
              />
              {epubBusy ? <p>Ingesting the EPUB…</p> : null}
              {epubError !== undefined ? <p role="alert">{epubError}</p> : null}
            </div>

            <form onSubmit={(event) => void onSubmitWork(event)}>
              <label htmlFor="work-title">Title</label>
              <input
                id="work-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                value={title}
              />

              <label htmlFor="work-type">Type</label>
              <select
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

              <label htmlFor="work-language">Language</label>
              <select
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

              <label htmlFor="work-author">Author or source</label>
              <select
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

              {authorChoice === newAuthorOption ? (
                <>
                  <label htmlFor="inline-author-name">New author or source name</label>
                  <input
                    id="inline-author-name"
                    onChange={(event) => setInlineAuthorName(event.currentTarget.value)}
                    value={inlineAuthorName}
                  />
                </>
              ) : null}

              <button type="submit">Create work</button>
              {workError !== undefined ? <p role="alert">{workError}</p> : null}
            </form>

            {works.length === 0 ? (
              <p>No works yet.</p>
            ) : (
              <ul aria-label="Created works">
                {works.map((item) => (
                  <li key={item.work.entryId}>
                    {item.work.title} — {item.author.name} ({formatWorkType(item.work.workType)},{" "}
                    {workLanguageLabels[item.work.language]}){" "}
                    <a
                      download={`${item.work.title}.md`}
                      href={`/api/works/${item.work.entryId}/content/markdown`}
                    >
                      Export Markdown
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : null}
    </main>
  );
}
