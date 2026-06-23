import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import type { ReadingUnitDto, WorkContentDto, WorkListItemDto } from "@whetstone/contracts";

import { fetchWorkContent, fetchWorks, ingestMarkdown } from "./contentApi";

type ReadyData = Readonly<{
  content: WorkContentDto;
  selectedWorkEntryId: string;
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
    data: { content, selectedWorkEntryId: first.work.entryId, works: list.works },
    status: "ready"
  };
}

export function WorkContentPanel(): React.JSX.Element {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  const [markdown, setMarkdown] = useState("");
  const [file, setFile] = useState<File | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    loadInitialState()
      .then(setState)
      .catch(() => setState({ status: "error" }));
  }, []);

  function applyContent(data: ReadyData, content: WorkContentDto, workEntryId: string): void {
    setState({ data: { ...data, content, selectedWorkEntryId: workEntryId }, status: "ready" });
  }

  async function onSelectWork(
    event: ChangeEvent<HTMLSelectElement>,
    data: ReadyData
  ): Promise<void> {
    const workEntryId = event.currentTarget.value;
    setError(undefined);

    try {
      applyContent(data, await fetchWorkContent(workEntryId), workEntryId);
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
      const content = await ingestMarkdown(data.selectedWorkEntryId, { kind: "manual", markdown });
      applyContent(data, content, data.selectedWorkEntryId);
      setMarkdown("");
      setError(undefined);
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
      const content = await ingestMarkdown(data.selectedWorkEntryId, {
        fileName: file.name,
        kind: "upload",
        markdown: await file.text()
      });
      applyContent(data, content, data.selectedWorkEntryId);
      setFile(undefined);
      setError(undefined);
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
    <section aria-labelledby="content-heading" className="card">
      <h2 id="content-heading">Work content</h2>

      {state.status === "loading" ? <p>Loading works…</p> : null}
      {state.status === "error" ? <p role="alert">Could not load works.</p> : null}
      {state.status === "empty" ? <p>Create a work first to add content.</p> : null}

      {state.status === "ready" ? (
        <div className="contentPanel">
          <label htmlFor="content-work">Work</label>
          <select
            id="content-work"
            onChange={(event) => void onSelectWork(event, state.data)}
            value={state.data.selectedWorkEntryId}
          >
            {state.data.works.map((item) => (
              <option key={item.work.entryId} value={item.work.entryId}>
                {item.work.title}
              </option>
            ))}
          </select>

          <form onSubmit={(event) => void onAddMarkdown(event, state.data)}>
            <label htmlFor="content-markdown">Markdown</label>
            <textarea
              id="content-markdown"
              onChange={(event) => setMarkdown(event.currentTarget.value)}
              value={markdown}
            />
            <button type="submit">Add Markdown content</button>
          </form>

          <form onSubmit={(event) => void onUploadFile(event, state.data)}>
            <label htmlFor="content-file">Upload a .md file</label>
            <input accept=".md" id="content-file" onChange={onChooseFile} type="file" />
            <button type="submit">Upload file</button>
          </form>

          {error !== undefined ? <p role="alert">{error}</p> : null}

          {renderContent(state.data.content)}
        </div>
      ) : null}
    </section>
  );
}

function renderContent(content: WorkContentDto): React.JSX.Element {
  if (content.readingUnits.length === 0) {
    return <p>No content yet.</p>;
  }

  return (
    <ol aria-label="Reading units">
      {content.readingUnits.map((unit) => renderReadingUnit(unit))}
    </ol>
  );
}

function renderReadingUnit(unit: ReadingUnitDto): React.JSX.Element {
  return (
    <li key={unit.entryId}>
      <h3>{unit.title ?? "Untitled section"}</h3>
      <ol aria-label="Blocks">
        {unit.blocks.map((block) => (
          <li key={block.entryId}>
            <span className="blockType">{block.blockType}</span>
            <span className="blockText">{block.plaintext}</span>
          </li>
        ))}
      </ol>
    </li>
  );
}
