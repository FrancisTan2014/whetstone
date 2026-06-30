import { useEffect, useState } from "react";

import type { RecallItemDto } from "@whetstone/contracts";
import type { ReviewRating } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";

type Phase = "error" | "loading" | "ready";

// The four self-grade controls, in increasing-confidence order. Each maps to an SM-2 grade in the API.
const ratingButtons: ReadonlyArray<Readonly<{ label: string; rating: ReviewRating }>> = [
  { label: "Again", rating: "again" },
  { label: "Hard", rating: "hard" },
  { label: "Good", rating: "good" },
  { label: "Easy", rating: "easy" }
];

// The Recall surface: today's DUE items (already capped server-side) as gentle, snoozeable proposals.
// Self-grading an item or snoozing it advances past it; an empty list is a calm "all caught up" — never
// a forced or unbounded wall. The reader stays calm: recall lives only here.
export function RecallPage(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<ReadonlyArray<RecallItemDto>>([]);
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        setItems(await fetchDueRecall());
        setPhase("ready");
      } catch {
        setPhase("error");
      }
    }

    void load();
  }, []);

  function dropItem(id: string): void {
    setItems((current) => current.filter((item) => item.id !== id));
  }

  async function grade(id: string, rating: ReviewRating): Promise<void> {
    try {
      await gradeRecall(id, rating);
      dropItem(id);
    } catch {
      setActionFailed(true);
    }
  }

  async function snooze(id: string): Promise<void> {
    try {
      await snoozeRecall(id);
      dropItem(id);
    } catch {
      setActionFailed(true);
    }
  }

  return (
    <section aria-labelledby="recall-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="recall-heading">
        Due to recall
      </h1>

      {actionFailed ? (
        <p className="mt-4 text-danger" role="alert">
          Could not update that item. Please try again.
        </p>
      ) : null}

      <div className="mt-6">
        {renderBody(
          phase,
          items,
          (id, rating) => void grade(id, rating),
          (id) => void snooze(id)
        )}
      </div>
    </section>
  );
}

function renderBody(
  phase: Phase,
  items: ReadonlyArray<RecallItemDto>,
  grade: (id: string, rating: ReviewRating) => void,
  snooze: (id: string) => void
): React.JSX.Element {
  if (phase === "loading") {
    return <LoadingIndicator label="Gathering what's due…" />;
  }

  if (phase === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load your recall items. Please try again.
      </p>
    );
  }

  if (items.length === 0) {
    return <p className="text-text-muted">Nothing due — you&rsquo;re all caught up.</p>;
  }

  return (
    <ul aria-label="Items due to recall" className="flex flex-col gap-4">
      {items.map((item) => (
        <RecallCard grade={grade} item={item} key={item.id} snooze={snooze} />
      ))}
    </ul>
  );
}

function RecallCard({
  grade,
  item,
  snooze
}: Readonly<{
  grade: (id: string, rating: ReviewRating) => void;
  item: RecallItemDto;
  snooze: (id: string) => void;
}>): React.JSX.Element {
  return (
    <li className="rounded border border-border bg-surface p-4">
      <p className="text-lg text-text">{item.text}</p>
      {item.gloss === null ? null : <p className="mt-1 text-sm text-text-muted">{item.gloss}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {ratingButtons.map((control) => (
          <Button
            key={control.rating}
            onClick={() => grade(item.id, control.rating)}
            size="sm"
            variant="secondary"
          >
            {control.label}
          </Button>
        ))}
        <Button onClick={() => snooze(item.id)} size="sm" variant="ghost">
          Snooze
        </Button>
      </div>
    </li>
  );
}
