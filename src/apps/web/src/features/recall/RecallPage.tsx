import { createElement, useEffect, useRef, useState } from "react";

import type { MemoryPromptCardDto } from "@whetstone/contracts";
import type { ReviewRating } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
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
function RecallPageComponent(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>("loading");
  const [items, setItems] = useState<ReadonlyArray<MemoryPromptCardDto>>([]);
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

  function dropItem(promptId: string): void {
    setItems((current) => current.filter((item) => item.promptId !== promptId));
  }

  function grade(promptId: string, rating: ReviewRating): void {
    void gradeRecall(promptId, rating).then(
      () => dropItem(promptId),
      () => setActionFailed(true)
    );
  }

  function snooze(promptId: string): void {
    void snoozeRecall(promptId).then(
      () => dropItem(promptId),
      () => setActionFailed(true)
    );
  }

  const body = createElement("section", {
    "aria-labelledby": "recall-heading",
    children: [
      createElement(
        "h1",
        { className: "text-2xl font-semibold text-text", id: "recall-heading", key: "heading" },
        "Due to recall"
      ),
      createElement(ActionFailureAlert, { failed: actionFailed, key: "action-failure" }),
      createElement(
        "div",
        { className: "mt-6", key: "body" },
        renderBody(phase, items, grade, snooze)
      )
    ],
    className: "mx-auto max-w-2xl p-6"
  });

  return body;
}

export const RecallPage = RecallPageComponent;

function ActionFailureAlert({ failed }: Readonly<{ failed: boolean }>): React.JSX.Element | null {
  if (!failed) {
    return null;
  }

  return createElement(
    "p",
    { className: "mt-4 text-danger", role: "alert" },
    "Could not update that item. Please try again."
  );
}

function renderBody(
  phase: Phase,
  items: ReadonlyArray<MemoryPromptCardDto>,
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
        <RecallCard grade={grade} item={item} key={item.promptId} snooze={snooze} />
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
  item: MemoryPromptCardDto;
  snooze: (id: string) => void;
}>): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const answerRef = useRef<HTMLDivElement>(null);

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
      grade(item.promptId, ratingButtons[index]!.rating);
    }
  }

  return (
    <li
      className="rounded border border-border bg-surface p-4"
      onKeyDown={revealed ? handleKeyDown : undefined}
    >
      {revealed ? (
        <>
          <p className="text-lg text-text">{item.cueText}</p>
          <div
            aria-label="Answer"
            className="mt-2 border-t border-border pt-2 focus-visible:outline-none"
            ref={answerRef}
            tabIndex={-1}
          >
            <p className="text-text">{item.answerText}</p>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {ratingButtons.map((control) => (
              <Button
                key={control.rating}
                onClick={() => grade(item.promptId, control.rating)}
                size="sm"
                variant="secondary"
              >
                {control.label}
              </Button>
            ))}
            <Button onClick={() => snooze(item.promptId)} size="sm" variant="ghost">
              Snooze
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-lg text-text">{item.cueText}</p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={() => setRevealed(true)} size="sm" variant="primary">
              Show answer
            </Button>
            <Button onClick={() => snooze(item.promptId)} size="sm" variant="ghost">
              Snooze
            </Button>
          </div>
        </>
      )}
    </li>
  );
}
