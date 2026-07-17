import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { NoteReviewEnrollmentStatusDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { addNoteToReview, fetchNoteReviewStatus } from "../notesReview/notesReviewApi";

type NoteReviewSectionProps = Readonly<{
  noteEntryId: string;
  // The exact anchor snapshot the learner confirms as the read-only Question — never retyped, never edited.
  question: string;
  workEntryId: string;
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

// The Review controls inside the note sheet (#658), shown only for a saved anchored note. It loads the
// note's objective Review status and lets the learner add the note to Review by confirming the exact
// anchor snapshot as the Question — no extra writing, no generated question. Enrollment is idempotent, so
// re-adding is safe; after success the section reflects the objective state (Due now with a Review link,
// Next review · date, or Paused). All states stay inside this section: a load or enrollment failure offers
// a retry without disturbing the note body above.
export function NoteReviewSection({
  noteEntryId,
  question,
  workEntryId
}: NoteReviewSectionProps): React.JSX.Element {
  const [state, setState] = useState<SectionState>({ step: "loading" });
  const [confirming, setConfirming] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollFailed, setEnrollFailed] = useState(false);

  // Defer the state transition into the promise callback (never a synchronous set in the effect body) so
  // the React Compiler's set-state-in-effect lint stays satisfied — the same loader shape Review uses. The
  // initial `loading` state carries the mount fetch; `retry` sets `loading` from its own event handler.
  const loadStatus = useCallback((): void => {
    fetchNoteReviewStatus(workEntryId, noteEntryId).then(
      (status) => setState({ status, step: "status" }),
      () => setState({ step: "error" })
    );
  }, [noteEntryId, workEntryId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  function retry(): void {
    setState({ step: "loading" });
    loadStatus();
  }

  function onAdd(): void {
    setEnrolling(true);
    setEnrollFailed(false);
    addNoteToReview(workEntryId, noteEntryId).then(
      (status) => {
        setEnrolling(false);
        setConfirming(false);
        setState({ status, step: "status" });
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
        <NoteReviewStatusView
          confirming={confirming}
          enrollFailed={enrollFailed}
          enrolling={enrolling}
          onAdd={onAdd}
          onCancelConfirm={() => {
            setConfirming(false);
            setEnrollFailed(false);
          }}
          onStartConfirm={() => setConfirming(true)}
          question={question}
          status={state.status}
        />
      ) : null}
    </section>
  );
}

type NoteReviewStatusViewProps = Readonly<{
  confirming: boolean;
  enrollFailed: boolean;
  enrolling: boolean;
  onAdd: () => void;
  onCancelConfirm: () => void;
  onStartConfirm: () => void;
  question: string;
  status: NoteReviewEnrollmentStatusDto;
}>;

// The objective view for a loaded status. `not_enrolled` offers "Add to review", which opens an inline
// confirmation showing the exact anchor snapshot as a read-only Question; the enrolled states are the
// calm, objective projections of the note's shared card.
function NoteReviewStatusView({
  confirming,
  enrollFailed,
  enrolling,
  onAdd,
  onCancelConfirm,
  onStartConfirm,
  question,
  status
}: NoteReviewStatusViewProps): React.JSX.Element {
  switch (status.status) {
    case "not_enrolled":
      return confirming ? (
        <div className="noteReviewConfirm">
          <p className="noteReviewQuestionLabel" id="noteReviewQuestionLabel">
            Question
          </p>
          <p aria-labelledby="noteReviewQuestionLabel" className="noteReviewQuestion">
            {question}
          </p>
          {enrollFailed ? (
            <p role="alert">Could not add the note to review. Please try again.</p>
          ) : null}
          <div className="noteReviewConfirmActions">
            <Button onClick={onAdd} pending={enrolling} type="button">
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
          <Link className="noteReviewLink" to="/notes/review">
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
