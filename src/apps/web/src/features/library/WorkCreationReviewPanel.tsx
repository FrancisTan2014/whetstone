import { workLanguageLabels } from "@whetstone/domain";
import type { WorkCreationReviewDto, WorkDuplicateCandidateReviewDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { Sheet } from "../../shared/ui/Sheet";
import { workDuplicateMatchTierLabels, workOriginLabels } from "./workCreationReview.tokens";

export type WorkCreationReviewPanelProps = Readonly<{
  onBack: () => void;
  onKeepSeparate: () => void;
  onOpenExisting: (entryId: string) => void;
  // While a decision is in flight every action is disabled so the revision-fenced attempt cannot be
  // double-submitted from the panel.
  pending: boolean;
  review: WorkCreationReviewDto;
}>;

function formatWorkType(workType: string): string {
  return workType.replace("_", " ");
}

// One candidate's factual evidence, rendered as plain phrases — never a "duplicate" verdict. Only the
// facts that actually distinguish or corroborate this candidate are shown, so the learner reads why two
// similar rows differ (or match) without the panel deciding for them.
function CandidateEvidence({
  candidate
}: Readonly<{ candidate: WorkDuplicateCandidateReviewDto }>): React.JSX.Element {
  const { evidence } = candidate;
  const facts: string[] = [`Title match ${Math.round(evidence.titleSimilarity * 100)}%`];

  facts.push(evidence.sameAuthor ? "Same author" : "Different author");

  if (evidence.languageDiffers) {
    facts.push("Different language");
  }

  if (evidence.workTypeDiffers) {
    facts.push("Different type");
  }

  if (evidence.editionMarkerDifferences.length > 0) {
    facts.push(`Edition differs: ${evidence.editionMarkerDifferences.join(", ")}`);
  }

  return (
    <div className="flex flex-wrap gap-2 text-sm text-text-muted">
      {facts.map((fact) => (
        <span className="rounded bg-bg px-2 py-1" key={fact}>
          {fact}
        </span>
      ))}
    </div>
  );
}

// The owner-scoped duplicate-review panel shown BEFORE an imported Markdown Work is created (#747). It
// presents the learner's proposal and the reviewed candidates as facts (full title, author, language,
// type, origin, and match evidence) and offers exactly three actions — Open existing (per candidate),
// Keep separate, and Back. It holds only the opaque attempt id + revision from the review DTO and emits
// a semantic decision; it never decides candidate policy or creates around the server boundary.
export function WorkCreationReviewPanel({
  onBack,
  onKeepSeparate,
  onOpenExisting,
  pending,
  review
}: WorkCreationReviewPanelProps): React.JSX.Element {
  const { proposed } = review;

  // The Sheet's own dismissals (Close button, Escape, overlay click) still fire while a decision is in
  // flight, even though the visible actions are disabled. Ignore any dismissal while `pending` so a
  // close cannot call Back and cancel the still-pending attempt — deleting the staged upload out from
  // under the Keep separate / Open existing the learner just submitted. Only a real close while idle
  // routes to Back.
  const handleOpenChange = (next: boolean): void => {
    if (next || pending) {
      return;
    }
    onBack();
  };

  return (
    <Sheet onOpenChange={handleOpenChange} open title="Possible duplicate">
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-1">
          <p className="text-text">
            You’re adding <span className="font-semibold">“{proposed.title}”</span> from{" "}
            <span className="font-medium">{review.sourceFileName}</span>.
          </p>
          <p className="text-sm text-text-muted">
            {proposed.authorName} · {workLanguageLabels[proposed.language]} ·{" "}
            {formatWorkType(proposed.workType)}
          </p>
          <p className="text-sm text-text-muted">
            {review.candidates.length === 1
              ? "This work looks similar to one already in your library."
              : `This work looks similar to ${review.candidates.length} already in your library.`}{" "}
            Open the existing one, or keep this as a separate work.
          </p>
        </section>

        <ul aria-label="Possible duplicates" className="flex flex-col gap-3">
          {review.candidates.map((candidate) => (
            <li
              className="flex flex-col gap-2 rounded border border-border bg-surface p-3"
              key={candidate.entryId}
            >
              <div className="flex flex-col gap-0.5">
                <p className="font-semibold text-text">{candidate.title}</p>
                <p className="text-sm text-text-muted">
                  {candidate.author.name} · {workLanguageLabels[candidate.language]} ·{" "}
                  {formatWorkType(candidate.workType)} · {workOriginLabels[candidate.origin]}
                </p>
                <p className="text-sm text-text-muted">
                  {workDuplicateMatchTierLabels[candidate.matchTier]}
                </p>
              </div>
              <CandidateEvidence candidate={candidate} />
              <div className="flex justify-end">
                <Button
                  aria-label={`Open existing “${candidate.title}”`}
                  disabled={pending}
                  onClick={() => onOpenExisting(candidate.entryId)}
                  type="button"
                  variant="secondary"
                >
                  Open existing
                </Button>
              </div>
            </li>
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
      </div>
    </Sheet>
  );
}
