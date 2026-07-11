import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { MemoryNoteSummaryDto } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { listMemoryNotes } from "./memoryApi";
import { MemoryList } from "./MemoryList";
import { MemoryNoteDetail } from "./MemoryNoteDetail";
import { MemoryQuickAdd } from "./MemoryQuickAdd";

type Phase = "error" | "loading" | "ready";

// The Memory surface: everything the learner has chosen to keep. The heading renders in every arm
// (including the initial static render) so the app shell can anchor it. Opening a row swaps the list
// for its detail; search narrows the list; Quick Add appends to it. The review flow itself lives at
// /recall — this page only links there when something is due.
export function MemoryPage(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [notes, setNotes] = useState<ReadonlyArray<MemoryNoteSummaryDto>>([]);
  const [query, setQuery] = useState("");
  const [activeQuery, setActiveQuery] = useState("");
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);

  const loadList = useCallback(async (term: string): Promise<void> => {
    try {
      setNotes(await listMemoryNotes(term));
      setActiveQuery(term.trim());
      setPhase("ready");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    void loadList("");
  }, [loadList]);

  function returnToList(): void {
    setSelectedNoteId(null);
    setQuery("");
    void loadList("");
  }

  function handleSearch(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void loadList(query);
  }

  return (
    <section aria-labelledby="memory-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="memory-heading">
        Memory
      </h1>
      <p className="mt-2 text-text-muted">Everything you&rsquo;ve chosen to keep.</p>

      <div className="mt-6">
        {renderBody(
          phase,
          notes,
          activeQuery,
          selectedNoteId,
          query,
          setQuery,
          handleSearch,
          setSelectedNoteId,
          returnToList
        )}
      </div>
    </section>
  );
}

function renderBody(
  phase: Phase,
  notes: ReadonlyArray<MemoryNoteSummaryDto>,
  activeQuery: string,
  selectedNoteId: string | null,
  query: string,
  setQuery: (value: string) => void,
  handleSearch: (event: React.FormEvent<HTMLFormElement>) => void,
  onSelect: (noteId: string) => void,
  returnToList: () => void
): React.JSX.Element {
  if (phase === "loading") {
    return <LoadingIndicator label="Gathering your memory…" />;
  }

  if (phase === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load your memory. Please try again.
      </p>
    );
  }

  if (selectedNoteId !== null) {
    return <MemoryNoteDetail noteId={selectedNoteId} onClose={returnToList} />;
  }

  const emptyMessage =
    activeQuery.length === 0 ? "Nothing kept yet — add your first memory above." : "No matches.";

  return (
    <div className="flex flex-col gap-6">
      <ReviewBanner notes={notes} />
      <MemoryQuickAdd onCreated={returnToList} />
      <form className="flex flex-col gap-1" onSubmit={handleSearch} role="search">
        <label className="text-sm text-text" htmlFor="memory-search">
          Search your memory
        </label>
        <input
          className="rounded border border-border bg-surface px-2 py-1 text-text"
          id="memory-search"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search what you&rsquo;ve kept"
          value={query}
        />
      </form>
      <MemoryList emptyMessage={emptyMessage} notes={notes} onSelect={onSelect} />
    </div>
  );
}

function ReviewBanner({
  notes
}: Readonly<{ notes: ReadonlyArray<MemoryNoteSummaryDto> }>): React.JSX.Element {
  const due = notes.reduce((total, note) => total + note.dueCount, 0);

  if (due === 0) {
    return <p className="text-text-muted">Nothing due right now.</p>;
  }

  return (
    <Link className={buttonVariants({ variant: "secondary" })} to="/recall">
      Review {due} due
    </Link>
  );
}
