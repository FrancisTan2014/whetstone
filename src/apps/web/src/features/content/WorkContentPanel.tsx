import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import type { ReadingUnitDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { workLanguageLabels, type WorkType } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchWorkContent, fetchWorks, ingestMarkdown, ingestPdf } from "./contentApi";
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

async function loadInitialState(focusWorkEntryId?: string): Promise<PanelState> {
  const list = await fetchWorks();
  const focused =
    focusWorkEntryId === undefined
      ? undefined
      : list.works.find((item) => item.work.entryId === focusWorkEntryId);
  const selected = focused ?? list.works[0];

  if (selected === undefined) {
    return { status: "empty" };
  }

  const content = await fetchWorkContent(selected.work.entryId);

  return {
    data: { content, selectedWork: selected, works: list.works },
    status: "ready"
  };
}

function formatWorkType(workType: WorkType): string {
  return workType.replace("_", " ");
}

// Shown when Markdown produced no readable blocks (the server's 422 `empty_content`), e.g. an
// image-only paste — v0 has no image block, so there is nothing to add.
const emptyContentMessage =
  "This Markdown has no readable text to add. Images on their own aren’t supported yet.";

// Shown when the doc-AI worker could not read an uploaded PDF (the server's 422 `invalid_pdf`), e.g. a
// scanned or corrupt file.
const invalidPdfMessage = "We couldn’t read this PDF. Please try a different file.";

// Detect a PDF selection so the single upload control can route it to the PDF worker instead of the
// Markdown path — by MIME type, falling back to the extension when the browser omits the type.
function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

function ingestedLabel(content: WorkContentDto): string {
  return `Ingested — ${workContentSummaryLabel(summarizeWorkContent(content))}.`;
}

type WorkContentPanelProps = Readonly<{
  // When this changes to a work's entry id (e.g. just after the Library creates or imports
  // one), the panel reloads its works and selects that work, so its content can be edited
  // without a page reload.
  focusWorkEntryId?: string | undefined;
}>;

export function WorkContentPanel({ focusWorkEntryId }: WorkContentPanelProps): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [markdown, setMarkdown] = useState("");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [uploadBusy, setUploadBusy] = useState(false);
  // Remount key for the uncontrolled file input: bumping it after each upload clears the picked
  // filename (a file input's value cannot be set programmatically).
  const [uploadNonce, setUploadNonce] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<string | undefined>(undefined);
  // The units/blocks overview summarizes by default (reading units + block counts); the per-block
  // plaintext/type rows stay collapsed behind an explicit "View blocks" affordance (#392).
  const [showBlocks, setShowBlocks] = useState(false);

  useEffect(() => {
    loadInitialState(focusWorkEntryId)
      .then(setState)
      .catch(() => setState({ status: "error" }));
  }, [focusWorkEntryId]);

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
      const outcome = await ingestMarkdown(data.selectedWork.work.entryId, {
        kind: "manual",
        markdown
      });

      if (outcome.status === "empty_content") {
        setResult(undefined);
        setError(emptyContentMessage);
        return;
      }

      applyContent(data, outcome.content, data.selectedWork);
      setMarkdown("");
      setError(undefined);
      setResult(ingestedLabel(outcome.content));
    } catch {
      setError("Could not add the Markdown content. Please try again.");
    }
  }

  async function onUploadFile(event: FormEvent, data: ReadyData): Promise<void> {
    event.preventDefault();

    if (file === undefined) {
      setError("Choose a .md or PDF file to upload.");
      return;
    }

    const pdf = isPdfFile(file);
    setUploadBusy(true);
    setError(undefined);
    setResult(undefined);

    try {
      const outcome = pdf
        ? await ingestPdf(data.selectedWork.work.entryId, file)
        : await ingestMarkdown(data.selectedWork.work.entryId, {
            fileName: file.name,
            kind: "upload",
            markdown: await file.text()
          });

      if (outcome.status === "invalid_pdf") {
        setError(invalidPdfMessage);
        return;
      }

      if (outcome.status === "empty_content") {
        setError(emptyContentMessage);
        return;
      }

      applyContent(data, outcome.content, data.selectedWork);
      setResult(ingestedLabel(outcome.content));
    } catch {
      setError(
        pdf
          ? "Could not upload the PDF. Please try again."
          : "Could not upload the file. Please try again."
      );
    } finally {
      // Clear the busy state and the chosen file after every attempt; a file input is uncontrolled,
      // so bump its remount key to fully clear the picked filename.
      setUploadBusy(false);
      setFile(undefined);
      setUploadNonce((nonce) => nonce + 1);
    }
  }

  function onChooseFile(event: ChangeEvent<HTMLInputElement>): void {
    // A file input always exposes a FileList; index 0 is undefined when cleared.
    const files = event.currentTarget.files as FileList;
    setFile(files[0]);
  }

  return (
    <section aria-label="Work detail" className="flex flex-col gap-6">
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
            onToggleBlocks: () => setShowBlocks((previous) => !previous),
            onUploadFile,
            result,
            setMarkdown,
            showBlocks,
            uploadBusy,
            uploadNonce
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
  onToggleBlocks: () => void;
  onUploadFile: (event: FormEvent, data: ReadyData) => void;
  result: string | undefined;
  setMarkdown: (value: string) => void;
  showBlocks: boolean;
  uploadBusy: boolean;
  uploadNonce: number;
}>;

function renderReady(data: ReadyData, handlers: ReadyHandlers): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {data.works.length > 1 ? renderWorkSwitcher(data, handlers) : null}
      {renderHeader(data)}
      {renderAddContent(data, handlers)}
      {renderOverview(data.content, handlers.showBlocks, handlers.onToggleBlocks)}
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
          Upload a .md or PDF file
          <input
            accept=".md,.pdf,application/pdf"
            disabled={handlers.uploadBusy}
            id="content-file"
            key={handlers.uploadNonce}
            onChange={handlers.onChooseFile}
            type="file"
          />
        </label>
        <Button
          className="self-start"
          disabled={handlers.uploadBusy}
          pending={handlers.uploadBusy}
          size="sm"
          type="submit"
          variant="secondary"
        >
          Upload file
        </Button>
        {handlers.uploadBusy ? <LoadingIndicator label="Converting the PDF…" /> : null}
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

function renderOverview(
  content: WorkContentDto,
  showBlocks: boolean,
  onToggleBlocks: () => void
): React.JSX.Element {
  if (content.readingUnits.length === 0) {
    return <p className="text-text-muted">No content yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-lg font-medium text-text">Content overview</h3>
        <Button
          aria-expanded={showBlocks}
          onClick={onToggleBlocks}
          size="sm"
          type="button"
          variant="secondary"
        >
          {showBlocks ? "Hide blocks" : "View blocks"}
        </Button>
      </div>
      <ol aria-label="Reading units" className="flex flex-col gap-4">
        {content.readingUnits.map((unit) => renderReadingUnit(unit, showBlocks))}
      </ol>
    </div>
  );
}

function renderReadingUnit(unit: ReadingUnitDto, showBlocks: boolean): React.JSX.Element {
  return (
    <li className="rounded border border-border bg-bg p-4" key={unit.entryId}>
      <h4 className="flex items-baseline gap-2 font-medium text-text">
        <span>{unit.title ?? "Untitled section"}</span>
        <span className="text-xs font-normal text-text-muted">
          {unit.blocks.length === 1 ? "1 block" : `${unit.blocks.length} blocks`}
        </span>
      </h4>
      {showBlocks ? (
        <ol aria-label="Blocks" className="mt-2 flex flex-col gap-1">
          {unit.blocks.map((block) => (
            <li className="flex gap-2 text-sm" key={block.entryId}>
              <span className="rounded bg-surface px-2 text-xs text-text-muted">
                {block.blockType}
              </span>
              <span className="text-text">{block.plaintext}</span>
            </li>
          ))}
        </ol>
      ) : null}
    </li>
  );
}
