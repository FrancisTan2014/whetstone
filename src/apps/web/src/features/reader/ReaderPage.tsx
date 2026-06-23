import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { WorkListItemDto } from "@whetstone/contracts";

import { fetchWorkContent, fetchWorks } from "./readerApi";
import { buildReaderView, type ReaderUnit, type ReaderView } from "./readerModel";

// remark-gfm mirrors the ingestion parser; rehype-sanitize strips unsafe HTML so
// the reader never executes raw markup (no dangerouslySetInnerHTML).
const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeSanitize];

type ReadingState =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "loading"; workEntryId: string }>
  | Readonly<{ status: "error"; workEntryId: string }>
  | Readonly<{ status: "viewing"; view: ReaderView; workEntryId: string }>;

type ReaderState =
  | Readonly<{ status: "loadingWorks" }>
  | Readonly<{ status: "worksError" }>
  | Readonly<{ reading: ReadingState; status: "ready"; works: ReadonlyArray<WorkListItemDto> }>;

export function ReaderPage(): React.JSX.Element {
  const [state, setState] = useState<ReaderState>({ status: "loadingWorks" });

  useEffect(() => {
    fetchWorks()
      .then((list) => setState({ reading: { status: "idle" }, status: "ready", works: list.works }))
      .catch(() => setState({ status: "worksError" }));
  }, []);

  async function openWork(
    works: ReadonlyArray<WorkListItemDto>,
    workEntryId: string
  ): Promise<void> {
    setState({ reading: { status: "loading", workEntryId }, status: "ready", works });

    try {
      const content = await fetchWorkContent(workEntryId);

      setState({
        reading: { status: "viewing", view: buildReaderView(content), workEntryId },
        status: "ready",
        works
      });
    } catch {
      setState({ reading: { status: "error", workEntryId }, status: "ready", works });
    }
  }

  return (
    <section aria-labelledby="reader-heading" className="readerShell">
      <h1 id="reader-heading">Reader</h1>

      {state.status === "loadingWorks" ? <p>Loading works…</p> : null}
      {state.status === "worksError" ? <p role="alert">Could not load works.</p> : null}

      {state.status === "ready"
        ? renderReady(
            state.works,
            state.reading,
            (workEntryId) => void openWork(state.works, workEntryId)
          )
        : null}
    </section>
  );
}

function renderReady(
  works: ReadonlyArray<WorkListItemDto>,
  reading: ReadingState,
  onOpen: (workEntryId: string) => void
): React.JSX.Element {
  if (works.length === 0) {
    return <p>No works yet. Create one in the library admin.</p>;
  }

  const openWorkEntryId = reading.status === "idle" ? undefined : reading.workEntryId;

  return (
    <div className="readerLayout">
      <nav aria-label="Works">
        <ul className="readerWorkList">
          {works.map((item) => (
            <li key={item.work.entryId}>
              <button
                aria-pressed={item.work.entryId === openWorkEntryId}
                onClick={() => onOpen(item.work.entryId)}
                type="button"
              >
                {item.work.title}
              </button>
            </li>
          ))}
        </ul>
      </nav>

      {renderReading(reading)}
    </div>
  );
}

function renderReading(reading: ReadingState): React.JSX.Element {
  switch (reading.status) {
    case "idle":
      return <p className="readerHint">Select a work to start reading.</p>;
    case "loading":
      return <p>Loading the work…</p>;
    case "error":
      return <p role="alert">Could not load this work. Please try again.</p>;
    case "viewing":
      return renderReaderView(reading.view);
  }
}

function renderReaderView(view: ReaderView): React.JSX.Element {
  if (view.units.length === 0) {
    return <p>This work has no content yet.</p>;
  }

  return (
    <article aria-label="Reading" className="reader">
      {view.units.map((unit) => renderUnit(unit))}
    </article>
  );
}

function renderUnit(unit: ReaderUnit): React.JSX.Element {
  return (
    <section className="readerUnit" key={unit.entryId}>
      {unit.title === undefined ? null : <h2 className="readerUnitTitle">{unit.title}</h2>}
      {unit.blocks.map((block) => (
        <div className="readerBlock" data-block-id={block.entryId} key={block.entryId}>
          <Markdown rehypePlugins={rehypePlugins} remarkPlugins={remarkPlugins}>
            {block.markdown}
          </Markdown>
        </div>
      ))}
    </section>
  );
}
