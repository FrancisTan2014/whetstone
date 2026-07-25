import type { MaterialReviewCandidateDto, MaterialReviewDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";

export type MaterialReviewPanelProps = Readonly<{
  // A retryable decision error (transient failure, or the reviewed evidence changed). Shown in the panel so
  // the learner can decide again without losing it. Null when the panel is idle.
  error: string | null;
  onBack: () => void;
  onKeepSeparate: () => void;
  onUseExisting: (noteId: string) => void;
  // While a decision is in flight every action is disabled so the revision-fenced attempt cannot be
  // double-submitted from the panel.
  pending: boolean;
  review: MaterialReviewDto;
}>;

function cardCountLabel(cardCount: number): string {
  return `${cardCount} ${cardCount === 1 ? "card" : "cards"}`;
}

// One candidate note's FACTUAL evidence that the drafted Answer already exists: its readable Answer excerpt,
// the Work/source context when the note is anchored, and how many review cards it already owns. It is never a
// "duplicate" verdict and never preselected by recency, source, or card count — the learner reads the facts
// and decides.
function CandidateRow({
  candidate,
  pending,
  onUseExisting
}: Readonly<{
  candidate: MaterialReviewCandidateDto;
  pending: boolean;
  onUseExisting: (noteId: string) => void;
}>): React.JSX.Element {
  return (
    <li className="flex flex-col gap-2 rounded border border-border bg-surface p-3">
      <p className="whitespace-pre-wrap break-words text-text">{candidate.answerExcerpt}</p>
      <div className="flex flex-wrap gap-2 text-sm text-text-muted">
        {candidate.sourceContext === null ? null : (
          <span className="rounded bg-bg px-2 py-1 break-words">{candidate.sourceContext}</span>
        )}
        <span className="rounded bg-bg px-2 py-1">{cardCountLabel(candidate.cardCount)}</span>
      </div>
      <div className="flex justify-end">
        <Button
          aria-label={`Use existing material from ${candidate.answerExcerpt}`}
          disabled={pending}
          onClick={() => onUseExisting(candidate.noteId)}
          type="button"
          variant="secondary"
        >
          Use existing material
        </Button>
      </div>
    </li>
  );
}

// The owner-scoped material-review panel shown when a New-card save's Answer already exists in Notes (#712).
// It keeps the learner's full draft and presents each existing candidate's Answer excerpt, source context,
// and card count as facts, offering exactly three actions — Use existing material (per candidate, adds the
// drafted contract to that note via #688), Keep separate (mint a distinct note), and Back (restore the
// draft). It holds only the opaque attempt id + revision from the review DTO and emits a semantic decision;
// it never decides candidate policy or creates around the server boundary.
export function MaterialReviewPanel({
  error,
  onBack,
  onKeepSeparate,
  onUseExisting,
  pending,
  review
}: MaterialReviewPanelProps): React.JSX.Element {
  // The Sheet's own dismissals (Close button, Escape, overlay click) still fire while a decision is in
  // flight, even though the visible actions are disabled. Ignore any dismissal while `pending` so a close
  // cannot call Back and drop the review out from under the decision the learner just submitted. Only a real
  // close while idle routes to Back, which restores the draft.
  const handleOpenChange = (next: boolean): void => {
    if (next || pending) {
      return;
    }
    onBack();
  };

  return (
    <Sheet
      onOpenChange={handleOpenChange}
      open
      size="wide"
      title="This material is already in Notes"
    >
      <div className="flex flex-col gap-5">
        <p className="text-sm text-text-muted">
          {review.candidates.length === 1
            ? "One existing note already covers this material."
            : `${review.candidates.length} existing notes already cover this material.`}{" "}
          Add this card to an existing note, or keep it as separate material.
        </p>

        <ul aria-label="Existing material" className="flex flex-col gap-3">
          {review.candidates.map((candidate) => (
            <CandidateRow
              candidate={candidate}
              key={candidate.noteId}
              onUseExisting={onUseExisting}
              pending={pending}
            />
          ))}
        </ul>

        <div className="flex flex-wrap justify-end gap-3">
          <Button disabled={pending} onClick={onBack} type="button" variant="ghost">
            Back
          </Button>
          <Button onClick={onKeepSeparate} pending={pending} type="button">
            Keep separate
          </Button>
        </div>

        {error === null ? null : (
          <p className="text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
