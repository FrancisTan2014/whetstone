import { useEffect, useRef, useState } from "react";

import type { RecitationReviewDto } from "@whetstone/contracts";
import { recitationRatingChoices } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { recordRecitationReview } from "./recitationApi";

// One whole-Work maintenance review (#643): the learner is asked to recite the exact Work from memory,
// Reveals the canonical source (read live from the Work's blocks — never copied into recitation state),
// then self-assesses with Again/Hard/Good/Easy. Only the rating updates FSRS; the reveal itself writes
// nothing. Rating appends exactly one review event and reschedules only this Work's card, and the
// rescheduled review is handed back so the page can show when the Work is next due.
export function RecitationReviewCard({
  onReviewed,
  review
}: Readonly<{
  onReviewed: (next: RecitationReviewDto) => void;
  review: RecitationReviewDto;
}>): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const sourceRef = useRef<HTMLParagraphElement>(null);

  // On reveal, move focus to the revealed source so a screen reader announces it (the rating buttons only
  // enter the a11y tree in this phase).
  useEffect(() => {
    if (revealed) {
      sourceRef.current?.focus();
    }
  }, [revealed]);

  function rate(rating: (typeof recitationRatingChoices)[number]["rating"]): void {
    setPending(true);
    setFailed(false);
    recordRecitationReview(review.planEntryId, rating).then(
      (response) => onReviewed(response.review),
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-text">
        Recite <span className="font-medium">{review.workTitle}</span> from memory, then reveal the
        source to check yourself.
      </p>

      {revealed ? (
        <div className="flex flex-col gap-3">
          <p
            aria-label="Source"
            className="whitespace-pre-wrap text-lg text-text focus-visible:outline-none"
            ref={sourceRef}
            tabIndex={-1}
          >
            {review.sourceText}
          </p>
          <div className="flex flex-wrap items-center gap-2" role="group">
            {recitationRatingChoices.map((choice) => (
              <Button
                key={choice.rating}
                onClick={() => rate(choice.rating)}
                pending={pending}
                size="sm"
                variant="secondary"
              >
                {choice.label}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <div>
          <Button onClick={() => setRevealed(true)} size="sm" variant="primary">
            Reveal
          </Button>
        </div>
      )}

      {failed ? (
        <p className="text-danger" role="alert">
          Could not save that rating. Please try again.
        </p>
      ) : null}
    </div>
  );
}
