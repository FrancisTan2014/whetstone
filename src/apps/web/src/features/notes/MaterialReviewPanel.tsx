import type {
  MaterialReviewCandidateDto,
  NearMatchDifferenceDto,
  NearMaterialReviewCandidateDto,
  MaterialReviewDto
} from "@whetstone/contracts";

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

// One near-match candidate's word-level difference rendered as a plain, factual phrase (#714). A changed word
// reads `existing → drafted`; a word the draft added reads `added "…"`; a word the draft dropped reads
// `removed "…"`. It is evidence for the learner's own comparison, never a verdict — the panel shows what
// differs, the learner judges whether the meaning is the same.
function describeDifference(difference: NearMatchDifferenceDto): string {
  if (difference.before.length === 0) {
    return `added “${difference.after}”`;
  }
  if (difference.after.length === 0) {
    return `removed “${difference.before}”`;
  }
  return `${difference.before} → ${difference.after}`;
}

function exactSummary(candidates: ReadonlyArray<MaterialReviewCandidateDto>): string {
  return candidates.length === 1
    ? "One existing note already covers this material."
    : `${candidates.length} existing notes already cover this material.`;
}

// One candidate note's FACTUAL evidence that the drafted Answer already exists (exactly, or as a near match):
// its readable Answer excerpt, the Work/source context when the note is anchored, and how many review cards it
// already owns. A NEAR candidate additionally lists the concrete word `differences` so the learner can compare
// meaning. It is never a "duplicate" verdict and never preselected by recency, source, or card count — the
// learner reads the facts and decides.
function CandidateRow({
  answerExcerpt,
  cardCount,
  differences,
  noteId,
  onUseExisting,
  pending,
  sourceContext
}: Readonly<{
  answerExcerpt: string;
  cardCount: number;
  differences?: ReadonlyArray<NearMatchDifferenceDto>;
  noteId: string;
  onUseExisting: (noteId: string) => void;
  pending: boolean;
  sourceContext: string | null;
}>): React.JSX.Element {
  return (
    <li className="flex flex-col gap-2 rounded border border-border bg-surface p-3">
      <p className="whitespace-pre-wrap break-words text-text">{answerExcerpt}</p>
      {differences !== undefined && differences.length > 0 ? (
        <ul aria-label="Wording differences" className="flex flex-wrap gap-2 text-sm text-text">
          {differences.map((difference, index) => (
            <li
              className="rounded bg-bg px-2 py-1 break-words"
              key={`${difference.before}→${difference.after}#${index}`}
            >
              {describeDifference(difference)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2 text-sm text-text-muted">
        {sourceContext === null ? null : (
          <span className="rounded bg-bg px-2 py-1 break-words">{sourceContext}</span>
        )}
        <span className="rounded bg-bg px-2 py-1">{cardCountLabel(cardCount)}</span>
      </div>
      <div className="flex justify-end">
        <Button
          aria-label={`Use existing material from ${answerExcerpt}`}
          disabled={pending}
          onClick={() => onUseExisting(noteId)}
          type="button"
          variant="secondary"
        >
          Use existing material
        </Button>
      </div>
    </li>
  );
}

// The owner-scoped material-review panel shown when a New-card save's Answer already exists in Notes — exactly
// or as a high-precision near match (#712, #714). It keeps the learner's full draft and presents two SEPARATE
// groups: exact material already in Notes, and "Possible duplicate" near matches (very similar wording, shown
// with the concrete word differences so the learner compares meaning). Each candidate offers Use existing
// material (adds the drafted contract to that note via #688); the panel also offers Keep separate (mint a
// distinct note) and Back (restore the draft). It holds only the opaque attempt id + revision from the review
// DTO and emits a semantic decision; it never decides candidate policy, never exposes a fuzzy score, and never
// creates around the server boundary.
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

  const hasExact = review.candidates.length > 0;
  const hasNear = review.nearCandidates.length > 0;

  return (
    <Sheet
      onOpenChange={handleOpenChange}
      open
      size="wide"
      title={hasExact ? "This material is already in Notes" : "Possible duplicate"}
    >
      <div className="flex flex-col gap-5">
        {hasExact ? (
          <div className="flex flex-col gap-3">
            {hasNear ? (
              <h3 className="text-base font-semibold text-text">
                This material is already in Notes
              </h3>
            ) : null}
            <p className="text-sm text-text-muted">
              {exactSummary(review.candidates)} Add this card to an existing note, or keep it as
              separate material.
            </p>
            <ul aria-label="Existing material" className="flex flex-col gap-3">
              {review.candidates.map((candidate) => (
                <CandidateRow
                  answerExcerpt={candidate.answerExcerpt}
                  cardCount={candidate.cardCount}
                  key={candidate.noteId}
                  noteId={candidate.noteId}
                  onUseExisting={onUseExisting}
                  pending={pending}
                  sourceContext={candidate.sourceContext}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {hasNear ? (
          <div className="flex flex-col gap-3">
            <h3 className="text-base font-semibold text-text">Possible duplicate</h3>
            <p className="text-sm text-text-muted">
              The wording is very similar. Compare the meaning before deciding.
            </p>
            <ul aria-label="Possible duplicate" className="flex flex-col gap-3">
              {review.nearCandidates.map((candidate: NearMaterialReviewCandidateDto) => (
                <CandidateRow
                  answerExcerpt={candidate.answerExcerpt}
                  cardCount={candidate.cardCount}
                  differences={candidate.differences}
                  key={candidate.noteId}
                  noteId={candidate.noteId}
                  onUseExisting={onUseExisting}
                  pending={pending}
                  sourceContext={candidate.sourceContext}
                />
              ))}
            </ul>
          </div>
        ) : null}

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
