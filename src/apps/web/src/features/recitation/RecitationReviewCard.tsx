import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";

import type { DueRecitationPassageDto, RecitationSupportLevelDto } from "@whetstone/contracts";
import type { SupportProjection } from "@whetstone/domain";
import {
  passageCueText,
  projectRecitationSupport,
  recitationRatingChoices,
  recitationSupportLevels,
  supportLevelShowsTarget
} from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { useMediaQuery } from "../../shared/ui/useMediaQuery";
import { supportFadeInitialOpacity, supportFadeTransition } from "./recitationFade.tokens";
import { reviewPassage, setSupportLevel } from "./recitationPassageApi";
import { recitationSupportLevelLabels } from "./recitationLabels";

// A masked run of the target: the length is shown as neutral glyphs (never the hidden characters), and a
// visually-hidden label announces it as "hidden text" so a screen reader hears an explicit gap rather
// than a misleading partial sentence (#579).
function MaskedRun({ length }: Readonly<{ length: number }>): React.JSX.Element {
  return (
    <span className="text-text-muted">
      <span aria-hidden="true">{"·".repeat(length)}</span>
      <span className="sr-only">hidden text</span>
    </span>
  );
}

// Render a faded projection of the passage: each source line becomes a block, each segment either the
// shown source text or a masked run. `whitespace-pre-wrap` preserves the original spacing so reduced
// levels keep the passage's shape.
function SupportText({
  projection
}: Readonly<{ projection: SupportProjection }>): React.JSX.Element {
  return (
    <span className="whitespace-pre-wrap">
      {projection.lines.map((line, lineIndex) => (
        // Lines are derived positionally from the canonical text, so the index is a stable key.
        <span className="block" key={lineIndex}>
          {line.length === 0
            ? "\u00a0"
            : line.map((segment, segmentIndex) =>
                segment.kind === "shown" ? (
                  <span key={segmentIndex}>{segment.text}</span>
                ) : (
                  <MaskedRun key={segmentIndex} length={segment.length} />
                )
              )}
        </span>
      ))}
    </span>
  );
}

// One due recitation passage as a two-phase attempt (#578, faded by #579): the learner chooses how much
// visual support to keep — the whole passage, the first half of each clause, each clause's first unit,
// or none (the external cue) — attempts aloud from that scaffold, Reveals the exact source, then
// self-assesses. Lowering the support level is the retrieval effort; the level is remembered per passage
// and is a preference, never a grade — only the final rating updates FSRS. Fading is a pure render-time
// projection over the canonical text (the reveal always shows the unchanged source). A passage whose
// source drifted beyond a safe re-anchor is shown as needing repair instead of practising stale text.
export function RecitationReviewCard({
  onReviewed,
  passage
}: Readonly<{
  onReviewed: () => void;
  passage: DueRecitationPassageDto;
}>): React.JSX.Element {
  const [supportLevel, setSupportLevelState] = useState<RecitationSupportLevelDto>(
    passage.supportLevel
  );
  const [revealed, setRevealed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
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

  // Persist the chosen level optimistically: the projection follows local state immediately, and a
  // failed save must not disrupt practice, so the network write is best-effort.
  function selectSupportLevel(level: RecitationSupportLevelDto): void {
    setSupportLevelState(level);
    void setSupportLevel(passage.passageEntryId, level).catch(() => undefined);
  }

  function rate(rating: (typeof recitationRatingChoices)[number]["rating"]): void {
    setPending(true);
    setFailed(false);
    reviewPassage(passage.passageEntryId, rating, passage.defaultCueStrength).then(
      () => onReviewed(),
      () => {
        setPending(false);
        setFailed(true);
      }
    );
  }

  const cueText = passageCueText(
    passage.defaultCueStrength,
    passage.targetText,
    passage.precedingText
  );

  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-sm text-text-muted">{passage.context}</p>
        {revealed ? (
          <p
            className="mt-1 text-lg text-text focus-visible:outline-none"
            ref={targetRef}
            tabIndex={-1}
          >
            {passage.targetText}
          </p>
        ) : supportLevelShowsTarget(supportLevel) ? (
          <motion.div
            animate={{ opacity: 1 }}
            className="mt-1 text-lg text-text"
            initial={{ opacity: supportFadeInitialOpacity(prefersReducedMotion) }}
            key={supportLevel}
            transition={supportFadeTransition(prefersReducedMotion)}
          >
            <SupportText projection={projectRecitationSupport(passage.targetText, supportLevel)} />
          </motion.div>
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
          <div aria-label="Support level" className="flex flex-wrap gap-2" role="group">
            {recitationSupportLevels.map((level) => (
              <Button
                aria-pressed={level === supportLevel}
                key={level}
                onClick={() => selectSupportLevel(level)}
                size="sm"
                variant={level === supportLevel ? "primary" : "ghost"}
              >
                {recitationSupportLevelLabels[level]}
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
