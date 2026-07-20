import { useCallback, useEffect, useState } from "react";

import type { ReviewHistoryEventDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { fetchNotePromptHistory } from "../notesReview/notesReviewApi";

type CardHistoryProps = Readonly<{ promptId: string }>;

// One card's append-only Review history (#660, #700), paged newest-first with "Load older". It reads only
// real card events — ratings (Again/Hard/Good/Easy) and resets (Schedule restarted) — never a fabricated
// entry. It is the third view of the Cards hierarchy: the Back control and heading are owned by the parent
// so this component stays a focused, reusable history reader.
export function CardHistory({ promptId }: CardHistoryProps): React.JSX.Element {
  const [events, setEvents] = useState<ReadonlyArray<ReviewHistoryEventDto>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [step, setStep] = useState<"loading" | "error" | "ready">("loading");
  const [loadingMore, setLoadingMore] = useState(false);

  // The first page REPLACES the list, so a re-run of this load (e.g. a StrictMode double-invoked mount
  // effect, or a retry) is idempotent and never duplicates events. Only "Load older" appends.
  const loadFirst = useCallback((): void => {
    fetchNotePromptHistory(promptId).then(
      (page) => {
        setEvents(page.events);
        setCursor(page.nextCursor);
        setStep("ready");
      },
      () => setStep("error")
    );
  }, [promptId]);

  useEffect(() => {
    loadFirst();
  }, [loadFirst]);

  function loadOlder(olderCursor: string): void {
    setLoadingMore(true);
    fetchNotePromptHistory(promptId, olderCursor).then(
      (page) => {
        setLoadingMore(false);
        setEvents((current) => [...current, ...page.events]);
        setCursor(page.nextCursor);
        setStep("ready");
      },
      () => {
        setLoadingMore(false);
        setStep("error");
      }
    );
  }

  function retry(): void {
    setStep("loading");
    loadFirst();
  }

  if (step === "loading") {
    return <p>Loading history…</p>;
  }
  if (step === "error") {
    return (
      <div>
        <p role="alert">Could not load the review history.</p>
        <Button onClick={retry} size="sm" type="button" variant="secondary">
          Retry
        </Button>
      </div>
    );
  }
  if (events.length === 0) {
    return <p>No review history yet.</p>;
  }
  return (
    <div>
      <ul className="noteReviewHistoryList">
        {events.map((event) => (
          <li key={event.id} className="noteReviewHistoryItem">
            <span className="noteReviewHistoryLabel">{historyLabel(event)}</span>
            <time dateTime={event.occurredAt}>{formatOccurredAt(event.occurredAt)}</time>
          </li>
        ))}
      </ul>
      {cursor !== null ? (
        <Button
          onClick={() => loadOlder(cursor)}
          pending={loadingMore}
          size="sm"
          type="button"
          variant="ghost"
        >
          Load older
        </Button>
      ) : null}
    </div>
  );
}

// The four-button rating localized for the history line, or the reset label. History carries no other kind.
function historyLabel(event: ReviewHistoryEventDto): string {
  if (event.kind === "reset") {
    return "Schedule restarted";
  }
  switch (event.rating) {
    case "again":
      return "Rated Again";
    case "hard":
      return "Rated Hard";
    case "good":
      return "Rated Good";
    case "easy":
      return "Rated Easy";
  }
}

function formatOccurredAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    year: "numeric"
  });
}
