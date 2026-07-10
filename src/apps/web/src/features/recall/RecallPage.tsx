import { useEffect, useRef, useState } from "react";

import type { RecallItemDto } from "@whetstone/contracts";
import type { ReviewRating } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { recallCardFaces } from "./recallCardFaces";
import { fetchDueRecall, gradeRecall, snoozeRecall } from "./recallApi";

type Phase = "error" | "loading" | "ready";

// The four self-grade controls, in increasing-confidence order. Each is an FSRS rating sent to the API.
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

// One due card as a two-phase flip (#525): a self-grade only means something after a retrieval
// attempt, so grade buttons are gated behind a reveal. Phase 1 (prompt) shows the front and the
// reveal affordance + Snooze; no grades. Phase 2 (reveal) shows the back and the four FSRS ratings.
// Reveal is a native <button> (so click/tap and Space/Enter all work); after reveal, focus moves to
// the answer region for assistive tech and 1–4 optionally map to the grades. Snooze is always present.
function RecallCard({
  grade,
  item,
  snooze
}: Readonly<{
  grade: (id: string, rating: ReviewRating) => void;
  item: RecallItemDto;
  snooze: (id: string) => void;
}>): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);
  const faces = recallCardFaces(item);

  // On reveal, move focus to the answer so a screen reader announces it (the grade buttons only enter
  // the a11y tree now, since they render solely in this phase).
  useEffect(() => {
    if (revealed) {
      answerRef.current?.focus();
    }
  }, [revealed]);

  // After reveal, 1–4 map to Again/Hard/Good/Easy — an optional keyboard accelerator. Only wired
  // while revealed (see `onKeyDown` below), so it never needs to re-check the phase.
  function handleKeyDown(event: React.KeyboardEvent<HTMLLIElement>): void {
    const index = ["1", "2", "3", "4"].indexOf(event.key);
    if (index !== -1) {
      event.preventDefault();
      grade(item.id, ratingButtons[index]!.rating);
    }
  }

  return (
    <li
      className="rounded border border-border bg-surface p-4"
      onKeyDown={revealed ? handleKeyDown : undefined}
    >
      {revealed ? (
        <>
          <p className="text-lg text-text">{faces.front}</p>
          <div
            aria-label="Answer"
            className="mt-2 border-t border-border pt-2 focus-visible:outline-none"
            ref={answerRef}
            tabIndex={-1}
          >
            {faces.answerless ? (
              <p className="text-sm text-text-muted">No saved answer — self-check from memory.</p>
            ) : (
              faces.back.map((line, index) => (
                <p
                  className={index === 0 ? "text-text" : "mt-1 text-sm text-text-muted"}
                  key={line}
                >
                  {line}
                </p>
              ))
            )}
          </div>

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
        </>
      ) : (
        <>
          <p className="text-lg text-text">{faces.front}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => setRevealed(true)} size="sm" variant="primary">
              Show answer
            </Button>
            <Button onClick={() => snooze(item.id)} size="sm" variant="ghost">
              Snooze
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
