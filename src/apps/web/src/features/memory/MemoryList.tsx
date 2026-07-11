import type { MemoryNoteSummaryDto } from "@whetstone/contracts";

import { captureSourceBadgeClass, memoryStateChipClass } from "./memory.tokens";
import { captureSourceLabel, memoryState, promptCountLabel } from "./memoryLabels";

type MemoryListProps = Readonly<{
  emptyMessage: string;
  notes: ReadonlyArray<MemoryNoteSummaryDto>;
  onSelect: (noteId: string) => void;
}>;

// The Memory list: one native <button> per kept fragment so click/tap and keyboard all open its
// detail. Each row reads jargon-free — fragment, how it was captured, how many prompts, and a single
// draft/scheduled/due state chip. An empty list shows the caller's calm message (full-list vs
// no-search-match), never an error.
export function MemoryList({ emptyMessage, notes, onSelect }: MemoryListProps): React.JSX.Element {
  if (notes.length === 0) {
    return <p className="text-text-muted">{emptyMessage}</p>;
  }

  return (
    <ul aria-label="Your memory" className="flex flex-col gap-3">
      {notes.map((note) => {
        const state = memoryState(note);

        return (
          <li key={note.noteId}>
            <button
              className="flex w-full flex-col items-start gap-1 rounded border border-border bg-surface p-4 text-left hover:bg-bg"
              onClick={() => onSelect(note.noteId)}
              type="button"
            >
              <span className="text-text">{note.bodyText}</span>
              <span className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  className={`rounded px-2 py-0.5 ${captureSourceBadgeClass(note.captureSource)}`}
                >
                  {captureSourceLabel(note.captureSource)}
                </span>
                <span className="text-text-muted">{promptCountLabel(note.promptCount)}</span>
                <span className={`rounded px-2 py-0.5 ${memoryStateChipClass(state.tone)}`}>
                  {state.label}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
