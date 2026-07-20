import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

import type { AuthoredWorkSummaryDto } from "@whetstone/contracts";
import {
  workLanguageLabels,
  workLanguages,
  workTypes,
  type WorkLanguage,
  type WorkType
} from "@whetstone/domain";

import { Button } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { PageFrame } from "../../shared/ui/PageFrame.js";
import { Sheet } from "../../shared/ui/Sheet.js";
import { useToast } from "../../shared/ui/toast/ToastProvider.js";
import { createAuthoredWork, listAuthoredWorks } from "./authoredWorkApi.js";

// The Writing home (#679): the primary Write destination's landing surface at `#/write` (no work id). It
// replaces the former "return to Library" recovery with a real Writing home — a single **New essay**
// action plus the current user's authored Works, most-recently-edited first, each with a persistent
// **Continue writing** and a secondary **Read**. Creation reuses the exact owned-Work API (no new table
// or copied document); the editor and reader render the same canonical Work.

type LoadState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; works: ReadonlyArray<AuthoredWorkSummaryDto> }>;

// A restrained, deterministic type/language line (`Essay · English`). `formatWorkType` humanizes the enum
// (`short_story` → `short story`); the language label comes from the shared domain map.
function formatWorkType(workType: WorkType): string {
  return workType.replace("_", " ");
}

// A stable, locale-fixed "last edited" line so the context reads the same in every timezone and in tests.
function formatLastEdited(updatedAt: string): string {
  const label = new Date(updatedAt).toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
    year: "numeric"
  });

  return `Last edited ${label}`;
}

// Newest edit first; ISO instants sort lexicographically in chronological order, so the client never
// depends on the server's ordering to present the recent-documents list correctly.
function byMostRecentlyEdited(
  works: ReadonlyArray<AuthoredWorkSummaryDto>
): ReadonlyArray<AuthoredWorkSummaryDto> {
  return [...works].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function WritingHomePage(): React.JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState<WorkLanguage>("en");
  const [workType, setWorkType] = useState<WorkType>("essay");
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();

  const fetchWorks = useCallback((): (() => void) => {
    let active = true;
    // A single guarded commit so a load that settles after the page unmounts (or after a newer retry
    // superseded it) never updates state on a torn-down tree.
    const commit = (next: LoadState): void => {
      if (active) {
        setLoad(next);
      }
    };
    listAuthoredWorks().then(
      (list) => commit({ status: "ready", works: byMostRecentlyEdited(list.works) }),
      () => commit({ status: "error" })
    );

    return () => {
      active = false;
    };
  }, []);

  // The initial state is already `loading`, so the mount effect only kicks off the fetch (its resolution
  // updates state asynchronously). `retry` runs from a click, so it may set `loading` synchronously.
  useEffect(() => fetchWorks(), [fetchWorks]);

  function retry(): void {
    setLoad({ status: "loading" });
    fetchWorks();
  }

  function openCreate(): void {
    setTitle("");
    setLanguage("en");
    setWorkType("essay");
    setFormError(undefined);
    setCreateOpen(true);
  }

  function onSubmitCreate(event: FormEvent): void {
    event.preventDefault();
    const trimmedTitle = title.trim();

    if (trimmedTitle.length === 0) {
      setFormError("Enter a document title.");
      return;
    }

    setSubmitting(true);
    setFormError(undefined);

    // The two-callback settle form (mirroring `fetchWorks`) keeps both the success and failure paths as
    // plain functions rather than a try/catch, which the React Compiler pass instruments cleanly.
    createAuthoredWork({ language, title: trimmedTitle, workType }).then(
      // Open the immersive editor for the new Work; leaving the sheet as-is until navigation avoids a flash.
      (created) => navigate(`/write?work=${encodeURIComponent(created.entryId)}`),
      () => {
        // A failed create keeps the form open with its values so the writer can retry without re-entering.
        setFormError("Could not create the document. Please try again.");
        toast.error("Could not create the document. Please try again.");
        setSubmitting(false);
      }
    );
  }

  return (
    <PageFrame
      primaryAction={
        <Button onClick={openCreate} type="button">
          New essay
        </Button>
      }
      title="Write"
      width="collection"
    >
      {load.status === "loading" ? <LoadingIndicator label="Loading your writing…" /> : null}
      {load.status === "error" ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-text-muted">Couldn&rsquo;t load your writing.</p>
          <Button onClick={retry} type="button" variant="secondary">
            Try again
          </Button>
        </div>
      ) : null}
      {load.status === "ready" ? <WritingList works={load.works} /> : null}

      {createOpen ? (
        <Sheet onOpenChange={() => setCreateOpen(false)} open title="New essay">
          <form className="flex flex-col gap-3" onSubmit={onSubmitCreate}>
            <label className="flex flex-col gap-1" htmlFor="writing-title">
              Title
              <input
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="writing-title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                value={title}
              />
            </label>

            <label className="flex flex-col gap-1" htmlFor="writing-type">
              Type
              <select
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="writing-type"
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

            <label className="flex flex-col gap-1" htmlFor="writing-language">
              Language
              <select
                className="min-h-11 rounded border border-border bg-surface px-3 py-2"
                id="writing-language"
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
            {formError !== undefined ? (
              <p className="text-danger" role="alert">
                {formError}
              </p>
            ) : null}
          </form>
        </Sheet>
      ) : null}
    </PageFrame>
  );
}

// The recent-documents list, or the empty on-ramp. The empty state explains that essays are saved as
// Works and leads with New essay (which lives in the header primary action above), so it never masquerades
// as a load failure. On a populated list, focus lands on the most-recent row's Continue action so
// returning from the editor restores a useful, keyboard-reachable position.
function WritingList({
  works
}: Readonly<{ works: ReadonlyArray<AuthoredWorkSummaryDto> }>): React.JSX.Element {
  const firstContinueRef = useRef<HTMLAnchorElement>(null);

  useEffect(() => {
    firstContinueRef.current?.focus();
  }, []);

  if (works.length === 0) {
    return (
      <p className="text-text-muted">
        Essays you write here are saved as Works in your Library. Start one with{" "}
        <span className="font-medium text-text">New essay</span>.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {works.map((work, index) => {
        const encoded = encodeURIComponent(work.entryId);
        return (
          <li
            className="flex flex-col gap-2 rounded border border-border bg-surface p-4"
            key={work.entryId}
          >
            <div className="flex flex-col gap-1">
              <h2 className="font-serif text-lg text-text">{work.title}</h2>
              <p className="text-xs text-text-muted">
                {formatWorkType(work.workType)} · {workLanguageLabels[work.language]} ·{" "}
                {formatLastEdited(work.updatedAt)}
              </p>
            </div>
            <div className="flex items-center gap-3">
              <a
                className="inline-flex min-h-[44px] items-center rounded bg-accent-selection px-3 py-2 text-sm font-medium text-accent"
                href={`#/write?work=${encoded}`}
                ref={index === 0 ? firstContinueRef : undefined}
              >
                Continue writing
              </a>
              <a
                className="inline-flex min-h-[44px] items-center rounded px-3 py-2 text-sm font-medium text-text-muted hover:text-text"
                href={`#/reader?work=${encoded}`}
              >
                Read
              </a>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
