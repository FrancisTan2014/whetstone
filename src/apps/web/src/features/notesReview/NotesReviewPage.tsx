import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import type {
  NotePromptSettingsDto,
  NoteReviewPromptDto,
  NoteRevealDto
} from "@whetstone/contracts";
import {
  formatNextReviewLabel,
  isShortTermReviewState,
  type ReviewRating
} from "@whetstone/domain";

import { PmDocument } from "../reader/PmDocument.js";
import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { PageFrame } from "../../shared/ui/PageFrame";
import { useLearnerTimeZone } from "../../shared/preferences/useLearnerTimeZone";
import { fetchNextNotePrompt, fetchNoteReveal, rateNotePrompt } from "./notesReviewApi";
import { RepairCardView } from "./RepairCardView";

// The four self-grade controls, in increasing-confidence order. Each is an FSRS rating sent to the API.
const ratingButtons: ReadonlyArray<Readonly<{ label: string; rating: ReviewRating }>> = [
  { label: "Again", rating: "again" },
  { label: "Hard", rating: "hard" },
  { label: "Good", rating: "good" },
  { label: "Easy", rating: "easy" }
];

type QuestionState = Readonly<{
  step: "question";
  prompt: NoteReviewPromptDto;
  revealFailed: boolean;
  restoreFixFocus?: true;
}>;

type RevealedState = Readonly<{
  step: "revealed";
  prompt: NoteReviewPromptDto;
  reveal: NoteRevealDto;
  restoreFixFocus?: true;
}>;

// The two settled review steps that expose a "Fix card" affordance and that a cancelled repair returns to
// exactly. Reveal/rating requests move into separate pending steps, where every competing control is inert.
type RepairableState = QuestionState | RevealedState;

// The whole session hinges on which step the single current prompt is in. Kept as one explicit
// discriminated state so an empty/error read can never masquerade as completion.
type SessionState =
  | Readonly<{ step: "loading" }>
  | Readonly<{ step: "error" }>
  | Readonly<{ step: "empty" }>
  | RepairableState
  | Readonly<{ step: "revealing"; prior: QuestionState }>
  | Readonly<{ step: "rating"; prior: RevealedState; rating: ReviewRating }>
  | Readonly<{ step: "repairing"; prior: RepairableState }>
  | Readonly<{ step: "rated"; nextDue: string; hasMoreDue: boolean; shortTerm: boolean }>;

// Rebuild the question-phase prompt from a committed repair: the clarified cue and its reveal kind come from
// the refreshed settings row, while the prompt/note identity and the untouched schedule (`review`) are kept
// from the prompt under repair. The learner re-attempts the same card from a fresh Question phase.
function repairedPrompt(
  prior: NoteReviewPromptDto,
  refreshed: NotePromptSettingsDto
): NoteReviewPromptDto {
  return {
    cueDoc: refreshed.questionDoc,
    cueText: refreshed.questionText,
    noteId: prior.noteId,
    promptId: prior.promptId,
    review: prior.review,
    revealKind: refreshed.reveal.kind
  };
}

// The Notes-owned Review session (#657): a one-item-at-a-time, two-phase review of the user's DUE note
// prompts. Nothing advances automatically — the learner reveals, rates, and chooses to continue. `/recall`
// and `/notes/review` both mount this; the reader stays calm, review lives only here.
function NotesReviewPageComponent(): React.JSX.Element {
  const navigate = useNavigate();
  const [state, setState] = useState<SessionState>({ step: "loading" });
  // A failed rating keeps the reveal (and its controls) in place; this flag surfaces a retryable alert
  // without collapsing the phase, so the learner never loses the answer they were grading.
  const [ratingFailed, setRatingFailed] = useState(false);
  // The learner's persisted zone (#676): the rated confirmation resolves its next-review label in it, so a
  // short-term interval reads as a truthful local time rather than the runner's zone.
  const timeZone = useLearnerTimeZone();

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

  function reveal(prior: QuestionState): void {
    setState({ prior, step: "revealing" });
    void fetchNoteReveal(prior.prompt.promptId).then(
      (resolved) => setState({ prompt: prior.prompt, reveal: resolved, step: "revealed" }),
      () => setState({ prompt: prior.prompt, revealFailed: true, step: "question" })
    );
  }

  function rate(rating: ReviewRating, prior: RevealedState): void {
    setRatingFailed(false);
    setState({ prior, rating, step: "rating" });
    void rateNotePrompt(prior.prompt.promptId, rating).then(
      (result) =>
        setState({
          hasMoreDue: result.remainingDue > 0,
          nextDue: result.review.due,
          shortTerm: isShortTermReviewState(result.review.state),
          step: "rated"
        }),
      () => {
        setState(prior);
        setRatingFailed(true);
      }
    );
  }

  // Enter the no-rating repair flow from the current step, remembering it so Cancel restores it exactly. A
  // stale rating alert is cleared so it never lingers behind the repair view.
  function startRepair(prior: RepairableState): void {
    setRatingFailed(false);
    setState({ prior, step: "repairing" });
  }

  function cancelRepair(prior: RepairableState): void {
    setState({ ...prior, restoreFixFocus: true });
  }

  // A committed repair: re-attempt the same prompt from a fresh Question phase with the clarified cue. The
  // schedule is untouched (the repair appended no rating), so the card is normally still due. But a
  // concurrent rating/pause/removal in another tab can leave the just-saved card no longer due; never
  // fabricate a due prompt from stale in-session state — only re-attempt when the refreshed row is still an
  // active due card, otherwise reload whatever is actually due next (or complete).
  function repaired(prior: NoteReviewPromptDto, refreshed: NotePromptSettingsDto): void {
    if (refreshed.cardState.state === "due") {
      setState({ prompt: repairedPrompt(prior, refreshed), revealFailed: false, step: "question" });
      return;
    }
    setState({ step: "loading" });
    loadNext();
  }

  // Edit the shared note body in the existing editor: navigate to the note, opened for editing (#659).
  function openNote(noteId: string): void {
    navigate(`/notes?open=${encodeURIComponent(noteId)}`);
  }

  return (
    <PageFrame parentLink={{ label: "Notes", to: "/notes" }} title="Review">
      <SessionBody
        onCancelRepair={cancelRepair}
        onFix={startRepair}
        onOpenNote={openNote}
        onRate={rate}
        onRepaired={repaired}
        onReveal={reveal}
        onReviewNext={reviewNext}
        ratingFailed={ratingFailed}
        state={state}
        timeZone={timeZone}
      />
    </PageFrame>
  );
}

export const NotesReviewPage = NotesReviewPageComponent;

function SessionBody({
  onCancelRepair,
  onFix,
  onOpenNote,
  onRate,
  onRepaired,
  onReveal,
  onReviewNext,
  ratingFailed,
  state,
  timeZone
}: Readonly<{
  onCancelRepair: (prior: RepairableState) => void;
  onFix: (prior: RepairableState) => void;
  onOpenNote: (noteId: string) => void;
  onRate: (rating: ReviewRating, prior: RevealedState) => void;
  onRepaired: (prior: NoteReviewPromptDto, refreshed: NotePromptSettingsDto) => void;
  onReveal: (prior: QuestionState) => void;
  onReviewNext: () => void;
  ratingFailed: boolean;
  state: SessionState;
  timeZone: string;
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
  if (state.step === "revealing") {
    return <QuestionView onFix={onFix} onReveal={onReveal} pending={true} state={state.prior} />;
  }
  if (state.step === "rating") {
    return (
      <RevealedView
        onFix={onFix}
        onRate={onRate}
        pendingRating={state.rating}
        ratingFailed={false}
        state={state.prior}
      />
    );
  }
  if (state.step === "repairing") {
    return (
      <RepairCardView
        noteId={state.prior.prompt.noteId}
        onCancel={() => onCancelRepair(state.prior)}
        onOpenNote={onOpenNote}
        onRepaired={(refreshed) => onRepaired(state.prior.prompt, refreshed)}
        promptId={state.prior.prompt.promptId}
      />
    );
  }
  if (state.step === "rated") {
    return (
      <div>
        <p className="text-text">
          {formatNextReviewLabel({
            due: new Date(state.nextDue),
            now: new Date(),
            shortTerm: state.shortTerm,
            timeZone
          })}
        </p>
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
        onFix={onFix}
        onRate={onRate}
        pendingRating={null}
        ratingFailed={ratingFailed}
        state={state}
      />
    );
  }
  return <QuestionView onFix={onFix} onReveal={onReveal} pending={false} state={state} />;
}

// Phase 1: the question and a single "Show note" affordance. No answer, no rating controls are exposed
// (visually or to assistive tech). A prior reveal failure surfaces a specific retry in place.
function QuestionView({
  onFix,
  onReveal,
  pending,
  state
}: Readonly<{
  onFix: (prior: RepairableState) => void;
  onReveal: (prior: QuestionState) => void;
  pending: boolean;
  state: QuestionState;
}>): React.JSX.Element {
  const fixRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (state.restoreFixFocus === true) {
      fixRef.current?.focus();
    }
  }, [state.restoreFixFocus]);

  return (
    <div>
      <div className="text-lg text-text">
        <PmDocument document={state.prompt.cueDoc} />
      </div>
      {state.revealFailed ? (
        <p className="mt-3 text-danger" role="alert">
          Could not show the note. Please try again.
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          onClick={pending ? undefined : () => onReveal(state)}
          pending={pending}
          variant="primary"
        >
          {state.revealFailed ? "Retry showing note" : "Show note"}
        </Button>
        <Button
          className="min-h-11"
          disabled={pending}
          onClick={pending ? undefined : () => onFix(state)}
          ref={fixRef}
          size="sm"
          type="button"
          variant="ghost"
        >
          Fix card
        </Button>
      </div>
    </div>
  );
}

// Phase 2: the resolved reveal (current canonical note body or preserved legacy custom answer, both rich)
// and the four 44px FSRS ratings. On reveal, focus moves to the answer so assistive tech announces it; 1–4
// optionally map to the ratings while this phase is shown.
function RevealedView({
  onFix,
  onRate,
  pendingRating,
  ratingFailed,
  state
}: Readonly<{
  onFix: (prior: RepairableState) => void;
  onRate: (rating: ReviewRating, prior: RevealedState) => void;
  pendingRating: ReviewRating | null;
  ratingFailed: boolean;
  state: RevealedState;
}>): React.JSX.Element {
  const answerRef = useRef<HTMLDivElement>(null);
  const fixRef = useRef<HTMLButtonElement>(null);
  const ratingPending = pendingRating !== null;

  useEffect(() => {
    (state.restoreFixFocus === true ? fixRef.current : answerRef.current)?.focus();
  }, [state.restoreFixFocus]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (ratingPending) {
      return;
    }
    const index = ["1", "2", "3", "4"].indexOf(event.key);
    if (index !== -1) {
      event.preventDefault();
      onRate(ratingButtons[index]!.rating, state);
    }
  }

  const revealContent =
    state.reveal.kind === "expected_response" ? (
      <>
        <div
          aria-label="Success check"
          className="mt-3 border-t border-border pt-3 text-text focus-visible:outline-none"
          ref={answerRef}
          tabIndex={-1}
        >
          <PmDocument document={state.reveal.successCheckDoc} />
        </div>
        <div aria-label="Reference" className="mt-3 border-t border-border pt-3 text-text-muted">
          <PmDocument document={state.reveal.referenceDoc} />
        </div>
      </>
    ) : (
      <div
        aria-label="Note"
        className="mt-3 border-t border-border pt-3 text-text focus-visible:outline-none"
        ref={answerRef}
        tabIndex={-1}
      >
        <PmDocument
          document={
            state.reveal.kind === "current_note" ? state.reveal.bodyDoc : state.reveal.answerDoc
          }
        />
      </div>
    );

  return (
    <div onKeyDown={handleKeyDown}>
      <div className="text-lg text-text">
        <PmDocument document={state.prompt.cueDoc} />
      </div>
      {revealContent}
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
            disabled={ratingPending}
            key={control.rating}
            onClick={ratingPending ? undefined : () => onRate(control.rating, state)}
            pending={pendingRating === control.rating}
            variant="secondary"
          >
            {control.label}
          </Button>
        ))}
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button
          className="min-h-11"
          disabled={ratingPending}
          onClick={ratingPending ? undefined : () => onFix(state)}
          ref={fixRef}
          size="sm"
          type="button"
          variant="ghost"
        >
          Fix card
        </Button>
      </div>
    </div>
  );
}
