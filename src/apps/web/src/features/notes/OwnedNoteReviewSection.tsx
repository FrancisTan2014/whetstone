import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { NoteDto, NoteReviewEnrollmentStatusDto } from "@whetstone/contracts";

import { Button, buttonVariants } from "../../shared/ui/Button";
import { addOwnedNoteToReview, fetchOwnedNoteReviewStatus } from "../notesReview/notesReviewApi";
import { NoteReviewSettings } from "./NoteReviewSettings";

type OwnedNoteReviewSectionProps = Readonly<{
  note: NoteDto;
  onEnrolled?: () => void;
}>;

// The section's own load lifecycle, kept explicit so a failed status read can never masquerade as a
// concrete enrollment state: the section shows a retry instead. Once loaded it holds the objective
// server status (not enrolled / due / scheduled / paused).
type SectionState =
  | Readonly<{ step: "loading" }>
  | Readonly<{ step: "error" }>
  | Readonly<{ status: NoteReviewEnrollmentStatusDto; step: "status" }>;

// Format a card's next due instant as a calm, localized date, matching the Review session's own format.
function formatNextReview(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

// The owner-scoped Review controls inside the Notes-home editor (#659), for any saved note. It loads the
// note's objective Review status and lets the learner add the note to Review. An anchored note reuses its
// exact source as the Question (server-side, no retyping); a standalone note has no source, so the learner
// answers exactly "What should Whetstone ask you?" in one required, non-blank input. Enrollment is
// idempotent; after success the section reflects the objective state (Due now with a Review link,
// Next review · date, or Paused). A load or enrollment failure offers a retry without disturbing the body.
export function OwnedNoteReviewSection({
  note,
  onEnrolled
}: OwnedNoteReviewSectionProps): React.JSX.Element {
  const [state, setState] = useState<SectionState>({ step: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollFailed, setEnrollFailed] = useState(false);
  const [question, setQuestion] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Defer the state transition into the promise callback (never a synchronous set in the effect body) so
  // the React Compiler's set-state-in-effect lint stays satisfied. The initial `loading` state carries the
  // mount fetch; `retry` sets `loading` from its own event handler.
  const loadStatus = useCallback((): void => {
    fetchOwnedNoteReviewStatus(note.entryId).then(
      (status) => setState({ status, step: "status" }),
      () => setState({ step: "error" })
    );
  }, [note.entryId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  function retry(): void {
    setState({ step: "loading" });
    loadStatus();
  }

  // An imported note carries a confirmed question on its `not_enrolled` status: like an anchored note, it
  // reuses an existing source rather than asking the learner to type one.
  const confirmedQuestion =
    state.step === "status" && state.status.status === "not_enrolled"
      ? state.status.question
      : undefined;
  const reuseSource = note.anchor !== null || confirmedQuestion !== undefined;
  const sourceQuestion =
    note.anchor !== null ? note.anchor.selectedTextSnapshot : confirmedQuestion;

  function onAdd(): void {
    // An anchored note reuses its source server-side; an imported note (#661) reuses its existing cardless
    // prompt's confirmed question. Both send no question. Only a plain standalone note sends the trimmed,
    // non-blank question the learner supplied.
    const supplied = reuseSource ? undefined : question.trim();
    setEnrolling(true);
    setEnrollFailed(false);
    addOwnedNoteToReview(note.entryId, supplied).then(
      (status) => {
        setEnrolling(false);
        setConfirming(false);
        setState({ status, step: "status" });
        onEnrolled?.();
      },
      () => {
        setEnrolling(false);
        setEnrollFailed(true);
      }
    );
  }

  return (
    <section aria-label="Review" className="noteReviewSection">
      <h3 className="noteReviewSectionHeading">Review</h3>
      {state.step === "loading" ? <p>Loading review status…</p> : null}
      {state.step === "error" ? (
        <div>
          <p role="alert">Could not load the review status.</p>
          <Button onClick={retry} type="button" variant="secondary">
            Retry
          </Button>
        </div>
      ) : null}
      {state.step === "status" ? (
        <OwnedNoteReviewStatusView
          confirming={confirming}
          enrollFailed={enrollFailed}
          enrolling={enrolling}
          onAdd={onAdd}
          onCancelConfirm={() => {
            setConfirming(false);
            setEnrollFailed(false);
          }}
          onQuestionChange={setQuestion}
          onStartConfirm={() => setConfirming(true)}
          question={sourceQuestion ?? question}
          reuseSource={reuseSource}
          status={state.status}
        />
      ) : null}
      {state.step === "status" ? (
        <div className="noteReviewSettingsDisclosure">
          <Button
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
            type="button"
            variant="ghost"
          >
            {settingsOpen ? "Hide review settings" : "Review settings"}
          </Button>
          {settingsOpen ? (
            <NoteReviewSettings
              noteEntryId={note.entryId}
              onChanged={() => {
                // A settings change can move this note's rolled-up state (paused/removed/restarted), so
                // refresh the compact summary and let the Notes-home list refresh its row too.
                loadStatus();
                onEnrolled?.();
              }}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

type OwnedNoteReviewStatusViewProps = Readonly<{
  confirming: boolean;
  enrollFailed: boolean;
  enrolling: boolean;
  onAdd: () => void;
  onCancelConfirm: () => void;
  onQuestionChange: (value: string) => void;
  onStartConfirm: () => void;
  question: string;
  reuseSource: boolean;
  status: NoteReviewEnrollmentStatusDto;
}>;

// The objective view for a loaded status. `not_enrolled` offers "Add to review", which opens an inline
// confirmation: a note that reuses an existing source — an anchored note's exact source, or an imported
// note's confirmed question — shows it as a read-only Question; a plain standalone note asks the learner
// "What should Whetstone ask you?" in one required input. The enrolled states are the calm, objective
// projections of the note's shared card.
function OwnedNoteReviewStatusView({
  confirming,
  enrollFailed,
  enrolling,
  onAdd,
  onCancelConfirm,
  onQuestionChange,
  onStartConfirm,
  question,
  reuseSource,
  status
}: OwnedNoteReviewStatusViewProps): React.JSX.Element {
  switch (status.status) {
    case "not_enrolled":
      return confirming ? (
        <div className="noteReviewConfirm">
          {reuseSource ? (
            <>
              <p className="noteReviewQuestionLabel" id="noteReviewQuestionLabel">
                Question
              </p>
              <p aria-labelledby="noteReviewQuestionLabel" className="noteReviewQuestion">
                {question}
              </p>
            </>
          ) : (
            <label className="noteReviewQuestionField">
              <span className="noteReviewQuestionLabel">What should Whetstone ask you?</span>
              <input
                className="noteReviewQuestionInput min-h-11"
                onChange={(event) => onQuestionChange(event.target.value)}
                type="text"
                value={question}
              />
            </label>
          )}
          {enrollFailed ? (
            <p role="alert">Could not add the note to review. Please try again.</p>
          ) : null}
          <div className="noteReviewConfirmActions">
            <Button
              disabled={!reuseSource && question.trim().length === 0}
              onClick={onAdd}
              pending={enrolling}
              type="button"
            >
              Add to review
            </Button>
            <Button
              disabled={enrolling}
              onClick={onCancelConfirm}
              type="button"
              variant="secondary"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <p>This note is not in review yet.</p>
          <Button onClick={onStartConfirm} type="button">
            Add to review
          </Button>
        </div>
      );
    case "due":
      return (
        <div>
          <p>Due now</p>
          <Link className={buttonVariants({ variant: "secondary" })} to="/notes/review">
            Review
          </Link>
        </div>
      );
    case "scheduled":
      return <p>Next review · {formatNextReview(status.nextReviewAt)}</p>;
    case "paused":
      return <p>Paused</p>;
  }
}
