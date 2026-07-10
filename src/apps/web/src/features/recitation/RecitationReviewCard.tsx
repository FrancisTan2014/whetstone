import { useEffect, useRef, useState } from "react";

import type { DueRecitationPassageDto, RecitationCueStrengthDto } from "@whetstone/contracts";
import { passageCueText, recitationCueStrengths, recitationRatingChoices } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { reviewPassage } from "./recitationPassageApi";
import { recitationCueStrengthLabels } from "./recitationLabels";

// One due recitation passage as a two-phase attempt (#578): attempt aloud from a restrained cue, Reveal
// the exact source, then self-assess. The cue never contains the full target (the domain derives it), and
// the target stays hidden until Reveal, so a grade only follows a real retrieval attempt. Switching cue
// strength before revealing changes only the hint; only the final rating updates FSRS. A passage whose
// source drifted beyond a safe re-anchor is shown as needing repair instead of practising stale text.
export function RecitationReviewCard({
  onReviewed,
  passage
}: Readonly<{
  onReviewed: () => void;
  passage: DueRecitationPassageDto;
}>): React.JSX.Element {
  const [cueStrength, setCueStrength] = useState<RecitationCueStrengthDto>(
    passage.defaultCueStrength
  );
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const targetRef = useRef<HTMLParagraphElement>(null);

  // On reveal, move focus to the revealed target so a screen reader announces it (the rating buttons
  // only enter the a11y tree in this phase).
  useEffect(() => {
    if (revealed) {
      targetRef.current?.focus();
    }
  }, [revealed]);

  if (passage.anchorStatus === "needs_repair") {
    return (
      <div className="flex flex-col gap-2">
        <p className="text-text">{passage.context}</p>
        <p className="text-text-muted" role="alert">
          This passage&rsquo;s source has changed. It needs repair before you practise it again.
        </p>
      </div>
    );
  }

  const cueText = passageCueText(cueStrength, passage.targetText, passage.precedingText);

  function rate(rating: (typeof recitationRatingChoices)[number]["rating"]): void {
    setPending(true);
    setFailed(false);
    reviewPassage(passage.passageEntryId, rating, cueStrength).then(
      () => onReviewed(),
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm text-text-muted">{passage.context}</p>
        {revealed ? (
          <p className="mt-1 text-lg text-text focus-visible:outline-none" ref={targetRef} tabIndex={-1}>
            {passage.targetText}
          </p>
        ) : (
          <p aria-label="Cue" className="mt-1 text-lg text-text">
            {cueText === "" ? (
              <span className="text-text-muted">No cue — begin from memory.</span>
            ) : (
              cueText
            )}
          </p>
        )}
      </div>

      {revealed ? (
        <div className="flex flex-wrap items-center gap-2">
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
      ) : (
        <div className="flex flex-col gap-2">
          <div aria-label="Cue strength" className="flex flex-wrap gap-2" role="group">
            {recitationCueStrengths.map((strength) => (
              <Button
                aria-pressed={strength === cueStrength}
                key={strength}
                onClick={() => setCueStrength(strength)}
                size="sm"
                variant={strength === cueStrength ? "primary" : "ghost"}
              >
                {recitationCueStrengthLabels[strength]}
              </Button>
            ))}
          </div>
          <div>
            <Button onClick={() => setRevealed(true)} size="sm" variant="primary">
              Reveal
            </Button>
          </div>
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
