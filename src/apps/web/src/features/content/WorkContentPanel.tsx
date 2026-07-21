import { useEffect, useState } from "react";

import type { ReadingUnitDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";
import { buildHeadingOutline, workLanguageLabels, type WorkType } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchWorkContent, fetchWorks } from "./contentApi";
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

type WorkContentPanelProps = Readonly<{
  // When this changes to a work's entry id (e.g. just after the Library imports one), the panel reloads
  // its works and selects that work, so its ingested content can be inspected without a page reload.
  focusWorkEntryId?: string | undefined;
}>;

export function WorkContentPanel({ focusWorkEntryId }: WorkContentPanelProps): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [error, setError] = useState<string | undefined>(undefined);
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

    try {
      applyContent(data, await fetchWorkContent(work.work.entryId), work);
    } catch {
      setError("Could not load this work's content. Please try again.");
    }
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
            onSelectWork,
            onToggleBlocks: () => setShowBlocks((previous) => !previous),
            showBlocks
          })
        : null}
    </section>
  );
}

type ReadyHandlers = Readonly<{
  error: string | undefined;
  onSelectWork: (work: WorkListItemDto, data: ReadyData) => void;
  onToggleBlocks: () => void;
  showBlocks: boolean;
}>;

function renderReady(data: ReadyData, handlers: ReadyHandlers): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      {data.works.length > 1 ? renderWorkSwitcher(data, handlers) : null}
      {renderHeader(data)}
      {handlers.error !== undefined ? (
        <p className="text-danger" role="alert">
          {handlers.error}
        </p>
      ) : null}
      {renderTableOfContents(data.content)}
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
        className="inline-flex min-h-11 items-center self-start text-sm text-accent hover:text-accent-hover"
        href={`#/reader?work=${encodeURIComponent(item.work.entryId)}`}
      >
        Open in Reader
      </a>
    </header>
  );
}

function renderTableOfContents(content: WorkContentDto): React.JSX.Element | null {
  const outline = buildHeadingOutline(
    content.readingUnits.map((unit) => ({
      entryId: unit.entryId,
      ...(unit.headingLevel === undefined ? {} : { headingLevel: unit.headingLevel }),
      ...(unit.title === undefined ? {} : { title: unit.title })
    }))
  );

  if (outline.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-lg font-medium text-text">Table of contents</h3>
      <ul aria-label="Table of contents" className="flex flex-col gap-1">
        {outline.map((entry) => (
          <li
            className="text-sm text-text"
            key={entry.entryId}
            style={{ paddingInlineStart: `${entry.depth * 1.25}rem` }}
          >
            {entry.label}
          </li>
        ))}
      </ul>
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
