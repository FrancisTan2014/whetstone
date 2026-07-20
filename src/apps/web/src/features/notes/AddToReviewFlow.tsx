import { useCallback, useEffect, useState } from "react";

import type { NoteReviewEnrollmentStatusDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { addOwnedNoteToReview, fetchOwnedNoteReviewStatus } from "../notesReview/notesReviewApi";

type AddToReviewFlowProps = Readonly<{
  noteEntryId: string;
  onEnrolled: () => void;
  // The anchored note's exact source snapshot, reused verbatim as the read-only Question. `null` for a
  // standalone note, which instead asks the learner "What should Whetstone ask you?".
  sourceSnapshot: string | null;
}>;

// The Cards-list toolbar enrollment for an eligible no-prompt note (#700): the single owner-scoped "Add to
// review" flow relocated intact from the old review section. An anchored note reuses its exact source as the
// Question (server-side, no retyping); an imported note reuses its confirmed cardless question; a plain
// standalone note answers exactly "What should Whetstone ask you?" in one required, non-blank input.
// Enrollment is idempotent. It renders no trigger at all unless the note is genuinely not enrolled, so the
// toolbar slot never shows a dead control or an empty gap for a note that already has a card.
export function AddToReviewFlow({
  noteEntryId,
  onEnrolled,
  sourceSnapshot
}: AddToReviewFlowProps): React.JSX.Element | null {
  const [status, setStatus] = useState<NoteReviewEnrollmentStatusDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const [enrollFailed, setEnrollFailed] = useState(false);
  const [question, setQuestion] = useState("");

  const loadStatus = useCallback((): void => {
    fetchOwnedNoteReviewStatus(noteEntryId).then(
      (next) => setStatus(next),
      () => setStatus(null)
    );
  }, [noteEntryId]);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // An imported note carries its confirmed question on a `not_enrolled` status: like an anchored note, it
  // reuses an existing source rather than asking the learner to type one.
  const confirmedQuestion =
    status !== null && status.status === "not_enrolled" ? status.question : undefined;
  const reuseSource = sourceSnapshot !== null || confirmedQuestion !== undefined;
  const displayedQuestion = sourceSnapshot ?? confirmedQuestion ?? question;

  function onAdd(): void {
    // An anchored note reuses its source server-side; an imported note reuses its cardless prompt's
    // confirmed question. Both send no question. Only a plain standalone note sends the trimmed, non-blank
    // question the learner supplied.
    const supplied = reuseSource ? undefined : question.trim();
    setEnrolling(true);
    setEnrollFailed(false);
    addOwnedNoteToReview(noteEntryId, supplied).then(
      () => {
        setEnrolling(false);
        setConfirming(false);
        onEnrolled();
      },
      () => {
        setEnrolling(false);
        setEnrollFailed(true);
      }
    );
  }

  // Only a genuinely not-enrolled note offers enrollment here; every other state (or a failed status read)
  // renders nothing so the toolbar slot stays empty rather than showing a dead trigger.
  if (status === null || status.status !== "not_enrolled") {
    return null;
  }

  if (!confirming) {
    return (
      <Button onClick={() => setConfirming(true)} type="button">
        Add to review
      </Button>
    );
  }

  return (
    <div className="noteReviewConfirm">
      {reuseSource ? (
        <>
          <p className="noteReviewQuestionLabel" id="addToReviewQuestionLabel">
            Question
          </p>
          <p aria-labelledby="addToReviewQuestionLabel" className="noteReviewQuestion">
            {displayedQuestion}
          </p>
        </>
      ) : (
        <label className="noteReviewQuestionField">
          <span className="noteReviewQuestionLabel">What should Whetstone ask you?</span>
          <input
            className="noteReviewQuestionInput min-h-11"
            onChange={(event) => setQuestion(event.target.value)}
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
          onClick={() => {
            setConfirming(false);
            setEnrollFailed(false);
          }}
          type="button"
          variant="secondary"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
