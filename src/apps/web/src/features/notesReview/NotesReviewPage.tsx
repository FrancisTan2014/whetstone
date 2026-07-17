import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

import type { NoteReviewPromptDto, NoteRevealDto } from "@whetstone/contracts";
import type { ReviewRating } from "@whetstone/domain";

import { PmDocument } from "../reader/PmDocument.js";
import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchNextNotePrompt, fetchNoteReveal, rateNotePrompt } from "./notesReviewApi";

// The four self-grade controls, in increasing-confidence order. Each is an FSRS rating sent to the API.
const ratingButtons: ReadonlyArray<Readonly<{ label: string; rating: ReviewRating }>> = [
  { label: "Again", rating: "again" },
  { label: "Hard", rating: "hard" },
  { label: "Good", rating: "good" },
  { label: "Easy", rating: "easy" }
];

// The whole session hinges on which step the single current prompt is in. Kept as one explicit
// discriminated state so an empty/error read can never masquerade as completion.
type SessionState =
  | Readonly<{ step: "loading" }>
  | Readonly<{ step: "error" }>
  | Readonly<{ step: "empty" }>
  | Readonly<{ step: "question"; prompt: NoteReviewPromptDto; revealFailed: boolean }>
  | Readonly<{ step: "revealed"; prompt: NoteReviewPromptDto; reveal: NoteRevealDto }>
  | Readonly<{ step: "rated"; nextDue: string; hasMoreDue: boolean }>;

// Format a card's next due instant as a calm, human date the learner reads after rating.
function formatDueDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

// The Notes-owned Review session (#657): a one-item-at-a-time, two-phase review of the user's DUE note
// prompts. Nothing advances automatically — the learner reveals, rates, and chooses to continue. `/recall`
// and `/notes/review` both mount this; the reader stays calm, review lives only here.
function NotesReviewPageComponent(): React.JSX.Element {
  const [state, setState] = useState<SessionState>({ step: "loading" });
  // A failed rating keeps the reveal (and its controls) in place; this flag surfaces a retryable alert
  // without collapsing the phase, so the learner never loses the answer they were grading.
  const [ratingFailed, setRatingFailed] = useState(false);

  // Defer every state transition through the promise's callbacks (never a synchronous set in the
  // effect body) so the React Compiler's set-state-in-effect lint stays satisfied — the same loader
  // shape Memory/Today use. The initial `loading` state carries the mount fetch; `reviewNext` sets
  // `loading` from its own event handler before re-loading.
  const loadNext = useCallback((): void => {
    fetchNextNotePrompt().then(
      (prompt) =>
        setState(
          prompt === null ? { step: "empty" } : { prompt, revealFailed: false, step: "question" }
        ),
      () => setState({ step: "error" })
    );
  }, []);

  useEffect(() => {
    loadNext();
  }, [loadNext]);

  function reviewNext(): void {
    setRatingFailed(false);
    setState({ step: "loading" });
    loadNext();
  }

  function reveal(prompt: NoteReviewPromptDto): void {
    void fetchNoteReveal(prompt.promptId).then(
      (resolved) => setState({ prompt, reveal: resolved, step: "revealed" }),
      () => setState({ prompt, revealFailed: true, step: "question" })
    );
  }

  function rate(rating: ReviewRating, prompt: NoteReviewPromptDto): void {
    setRatingFailed(false);
    void rateNotePrompt(prompt.promptId, rating).then(
      (result) =>
        setState({
          hasMoreDue: result.remainingDue > 0,
          nextDue: result.review.due,
          step: "rated"
        }),
      () => setRatingFailed(true)
    );
  }

  return (
    <section aria-labelledby="notes-review-heading" className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-semibold text-text" id="notes-review-heading">
        Review
      </h1>
      <div className="mt-6">
        <SessionBody
          onRate={rate}
          onReveal={reveal}
          onReviewNext={reviewNext}
          ratingFailed={ratingFailed}
          state={state}
        />
      </div>
      <p className="mt-8">
        <Link className="text-text-muted underline" to="/notes">
          Back to Notes
        </Link>
      </p>
    </section>
  );
}

export const NotesReviewPage = NotesReviewPageComponent;

function SessionBody({
  onRate,
  onReveal,
  onReviewNext,
  ratingFailed,
  state
}: Readonly<{
  onRate: (rating: ReviewRating, prompt: NoteReviewPromptDto) => void;
  onReveal: (prompt: NoteReviewPromptDto) => void;
  onReviewNext: () => void;
  ratingFailed: boolean;
  state: SessionState;
}>): React.JSX.Element {
  if (state.step === "loading") {
    return <LoadingIndicator label="Finding what's due…" />;
  }
  if (state.step === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load your review. Please try again.
      </p>
    );
  }
  if (state.step === "empty") {
    return <p className="text-text-muted">Due complete — nothing else is due right now.</p>;
  }
  if (state.step === "rated") {
    return (
      <div>
        <p className="text-text">Next review: {formatDueDate(state.nextDue)}</p>
        {state.hasMoreDue ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button onClick={onReviewNext} variant="primary">
              Review next
            </Button>
          </div>
        ) : (
          <p className="mt-4 text-text-muted">Due complete — nothing else is due right now.</p>
        )}
      </div>
    );
  }
  if (state.step === "revealed") {
    return (
      <RevealedView
        onRate={onRate}
        prompt={state.prompt}
        ratingFailed={ratingFailed}
        reveal={state.reveal}
      />
    );
  }
  return (
    <QuestionView onReveal={onReveal} prompt={state.prompt} revealFailed={state.revealFailed} />
  );
}

// Phase 1: the question and a single "Show note" affordance. No answer, no rating controls are exposed
// (visually or to assistive tech). A prior reveal failure surfaces a specific retry in place.
function QuestionView({
  onReveal,
  prompt,
  revealFailed
}: Readonly<{
  onReveal: (prompt: NoteReviewPromptDto) => void;
  prompt: NoteReviewPromptDto;
  revealFailed: boolean;
}>): React.JSX.Element {
  return (
    <div>
      <div className="text-lg text-text">
        <PmDocument document={prompt.cueDoc} />
      </div>
      {revealFailed ? (
        <p className="mt-3 text-danger" role="alert">
          Could not show the note. Please try again.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => onReveal(prompt)} variant="primary">
          {revealFailed ? "Retry showing note" : "Show note"}
        </Button>
      </div>
    </div>
  );
}

// Phase 2: the resolved reveal (current canonical note body or preserved legacy custom answer, both rich)
// and the four 44px FSRS ratings. On reveal, focus moves to the answer so assistive tech announces it; 1–4
// optionally map to the ratings while this phase is shown.
function RevealedView({
  onRate,
  prompt,
  ratingFailed,
  reveal
}: Readonly<{
  onRate: (rating: ReviewRating, prompt: NoteReviewPromptDto) => void;
  prompt: NoteReviewPromptDto;
  ratingFailed: boolean;
  reveal: NoteRevealDto;
}>): React.JSX.Element {
  const answerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    answerRef.current?.focus();
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const index = ["1", "2", "3", "4"].indexOf(event.key);
    if (index !== -1) {
      event.preventDefault();
      onRate(ratingButtons[index]!.rating, prompt);
    }
  }

  const revealDoc = reveal.kind === "current_note" ? reveal.bodyDoc : reveal.answerDoc;

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="text-lg text-text">
        <PmDocument document={prompt.cueDoc} />
      </div>
      <div
        aria-label="Note"
        className="mt-3 border-t border-border pt-3 text-text focus-visible:outline-none"
        ref={answerRef}
        tabIndex={-1}
      >
        <PmDocument document={revealDoc} />
      </div>
      {ratingFailed ? (
        <p className="mt-3 text-danger" role="alert">
          Could not save that rating. Please try again.
        </p>
      ) : null}
      <div
        aria-label="Rate your recall"
        className="mt-5 flex flex-wrap items-center gap-2"
        role="group"
      >
        {ratingButtons.map((control) => (
          <Button
            key={control.rating}
            onClick={() => onRate(control.rating, prompt)}
            variant="secondary"
          >
            {control.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
