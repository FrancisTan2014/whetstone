import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import type { ReadingUnitDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { workLanguageLabels, type WorkType } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchWorkContent, fetchWorks, ingestMarkdown } from "./contentApi";
import { summarizeWorkContent, workContentSummaryLabel } from "./workContentSummary";

type ReadyData = Readonly<{
  content: WorkContentDto;
  selectedWork: WorkListItemDto;
  works: ReadonlyArray<WorkListItemDto>;
}>;

type PanelState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "empty" }>
  | Readonly<{ data: ReadyData; status: "ready" }>;

async function loadInitialState(): Promise<PanelState> {
  const list = await fetchWorks();
  const first = list.works[0];

  if (first === undefined) {
    return { status: "empty" };
  }

  const content = await fetchWorkContent(first.work.entryId);

  return {
    data: { content, selectedWork: first, works: list.works },
    status: "ready"
  };
}

function formatWorkType(workType: WorkType): string {
  return workType.replace("_", " ");
}

function ingestedLabel(content: WorkContentDto): string {
  return `Ingested — ${workContentSummaryLabel(summarizeWorkContent(content))}.`;
}

export function WorkContentPanel(): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [markdown, setMarkdown] = useState("");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<string | undefined>(undefined);

  useEffect(() => {
    loadInitialState()
      .then(setState)
      .catch(() => setState({ status: "error" }));
  }, []);

  function applyContent(data: ReadyData, content: WorkContentDto, work: WorkListItemDto): void {
    setState({ data: { ...data, content, selectedWork: work }, status: "ready" });
  }

  async function onSelectWork(work: WorkListItemDto, data: ReadyData): Promise<void> {
    setError(undefined);
    setResult(undefined);

    try {
      applyContent(data, await fetchWorkContent(work.work.entryId), work);
    } catch {
      setError("Could not load this work's content. Please try again.");
    }
  }

  async function onAddMarkdown(event: FormEvent, data: ReadyData): Promise<void> {
    event.preventDefault();

    if (markdown.trim().length === 0) {
      setError("Enter some Markdown to add.");
      return;
    }

    try {
      const content = await ingestMarkdown(data.selectedWork.work.entryId, {
        kind: "manual",
        markdown
      });
      applyContent(data, content, data.selectedWork);
      setMarkdown("");
      setError(undefined);
      setResult(ingestedLabel(content));
    } catch {
      setError("Could not add the Markdown content. Please try again.");
    }
  }

  async function onUploadFile(event: FormEvent, data: ReadyData): Promise<void> {
    event.preventDefault();

    if (file === undefined) {
      setError("Choose a .md file to upload.");
      return;
    }

    try {
      const content = await ingestMarkdown(data.selectedWork.work.entryId, {
        fileName: file.name,
        kind: "upload",
        markdown: await file.text()
      });
      applyContent(data, content, data.selectedWork);
      setFile(undefined);
      setError(undefined);
      setResult(ingestedLabel(content));
    } catch {
      setError("Could not upload the file. Please try again.");
    }
  }

  function onChooseFile(event: ChangeEvent<HTMLInputElement>): void {
    // A file input always exposes a FileList; index 0 is undefined when cleared.
    const files = event.currentTarget.files as FileList;
    setFile(files[0]);
  }

  return (
    <section
      aria-labelledby="content-heading"
      className="mx-auto mt-8 flex max-w-5xl flex-col gap-6 rounded border border-border bg-surface p-6"
    >
      <h2 className="text-2xl font-semibold text-text" id="content-heading">
        Work detail
      </h2>

      {state.status === "loading" ? <LoadingIndicator label="Loading works…" /> : null}
      {state.status === "error" ? <p role="alert">Could not load works.</p> : null}
      {state.status === "empty" ? (
        <p className="text-text-muted">Create a work first to add content.</p>
      ) : null}

      {state.status === "ready"
        ? renderReady(state.data, {
            error,
            markdown,
            onAddMarkdown,
            onChooseFile,
            onSelectWork,
            onUploadFile,
            result,
            setMarkdown
          })
        : null}
    </section>
  );
}

type ReadyHandlers = Readonly<{
  error: string | undefined;
  markdown: string;
  onAddMarkdown: (event: FormEvent, data: ReadyData) => void;
  onChooseFile: (event: ChangeEvent<HTMLInputElement>) => void;
  onSelectWork: (work: WorkListItemDto, data: ReadyData) => void;
  onUploadFile: (event: FormEvent, data: ReadyData) => void;
  result: string | undefined;
  setMarkdown: (value: string) => void;
}>;

function renderReady(data: ReadyData, handlers: ReadyHandlers): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {data.works.length > 1 ? renderWorkSwitcher(data, handlers) : null}
      {renderHeader(data)}
      {renderAddContent(data, handlers)}
      {renderOverview(data.content)}
    </div>
  );
}

function renderWorkSwitcher(data: ReadyData, handlers: ReadyHandlers): React.JSX.Element {
  return (
    <nav aria-label="Works" className="flex flex-wrap gap-2">
      {data.works.map((item) => {
        const selected = item.work.entryId === data.selectedWork.work.entryId;

        return (
          <Button
            aria-pressed={selected}
            key={item.work.entryId}
            onClick={() => handlers.onSelectWork(item, data)}
            size="sm"
            variant={selected ? "primary" : "secondary"}
          >
            {item.work.title}
          </Button>
        );
      })}
    </nav>
  );
}

function renderHeader(data: ReadyData): React.JSX.Element {
  const item = data.selectedWork;
  const summaryLabel = workContentSummaryLabel(summarizeWorkContent(data.content));

  return (
    <header className="flex flex-col gap-2 border-b border-border pb-4">
      <h3 className="font-serif text-2xl text-text">{item.work.title}</h3>
      <p className="text-sm text-text-muted">
        {item.author.name} · {formatWorkType(item.work.workType)} ·{" "}
        {workLanguageLabels[item.work.language]}
      </p>
      <p className="text-sm text-text-muted">{summaryLabel}</p>
      <a
        className="text-sm text-accent hover:text-accent-hover"
        href={`#/reader?work=${encodeURIComponent(item.work.entryId)}`}
      >
        Open in Reader
      </a>
    </header>
  );
}

function renderAddContent(data: ReadyData, handlers: ReadyHandlers): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <h4 className="text-lg font-medium text-text">Add content</h4>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => handlers.onAddMarkdown(event, data)}
      >
        <label className="flex flex-col gap-1 text-sm text-text-muted" htmlFor="content-markdown">
          Markdown
          <textarea
            className="min-h-32 rounded border border-border bg-bg px-3 py-2 font-mono text-sm text-text"
            id="content-markdown"
            onChange={(event) => handlers.setMarkdown(event.currentTarget.value)}
            value={handlers.markdown}
          />
        </label>
        <Button className="self-start" size="sm" type="submit">
          Add Markdown content
        </Button>
      </form>

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => handlers.onUploadFile(event, data)}
      >
        <label className="flex flex-col gap-1 text-sm text-text-muted" htmlFor="content-file">
          Upload a .md file
          <input accept=".md" id="content-file" onChange={handlers.onChooseFile} type="file" />
        </label>
        <Button className="self-start" size="sm" type="submit" variant="secondary">
          Upload file
        </Button>
      </form>

      {handlers.result !== undefined ? (
        <p className="text-sm text-accent" role="status">
          {handlers.result}
        </p>
      ) : null}
      {handlers.error !== undefined ? (
        <p className="text-danger" role="alert">
          {handlers.error}
        </p>
      ) : null}
    </div>
  );
}

function renderOverview(content: WorkContentDto): React.JSX.Element {
  if (content.readingUnits.length === 0) {
    return <p className="text-text-muted">No content yet.</p>;
  }

  return (
    <ol aria-label="Reading units" className="flex flex-col gap-4">
      {content.readingUnits.map((unit) => renderReadingUnit(unit))}
    </ol>
  );
}

function renderReadingUnit(unit: ReadingUnitDto): React.JSX.Element {
  return (
    <li className="rounded border border-border bg-bg p-4" key={unit.entryId}>
      <h5 className="mb-2 flex items-baseline gap-2 font-medium text-text">
        <span>{unit.title ?? "Untitled section"}</span>
        <span className="text-xs font-normal text-text-muted">
          {unit.blocks.length === 1 ? "1 block" : `${unit.blocks.length} blocks`}
        </span>
      </h5>
      <ol aria-label="Blocks" className="flex flex-col gap-1">
        {unit.blocks.map((block) => (
          <li className="flex gap-2 text-sm" key={block.entryId}>
            <span className="rounded bg-surface px-2 text-xs text-text-muted">
              {block.blockType}
            </span>
            <span className="text-text">{block.plaintext}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}
