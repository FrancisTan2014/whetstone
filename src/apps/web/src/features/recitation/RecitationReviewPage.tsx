import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { RecitationReviewDto } from "@whetstone/contracts";

import { Button, buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchRecitationReview } from "./recitationApi";
import { RecitationReviewCard } from "./RecitationReviewCard";

type ReviewState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ review: RecitationReviewDto | null; status: "ready" }>
  | Readonly<{ remainingDueCount: number; scheduled: RecitationReviewDto; status: "done" }>;

// The direct Recitation maintenance page (#643/#637): it opens ONE whole-Work review. With `?work=<id>`
// it opens THAT exact Work's review (the review right after "I can recite this"); without it, the earliest-
// due Work selected by #633. When nothing is due — or the Work is not enrolled / was paused or removed —
// it shows a calm recovery pointing back to the Library, never a dead or misleading screen. After a rating
// it confirms the next scheduled date, then — recomputed from the canonical due cards — offers an optional
// "Review next" while other Works remain due, or "Due complete" when none do. The next Work NEVER opens
// automatically; the learner chooses. No passage, chain, phase, or session surface exists (retired #643).
export function RecitationReviewPage({
  workEntryId
}: Readonly<{ workEntryId?: string | undefined }> = {}): React.JSX.Element {
  const [state, setState] = useState<ReviewState>({ status: "loading" });

  // Load one review: the given Work, or — when omitted — the earliest-due Work recomputed from canonical
  // due cards. Only sets state once the fetch settles (never synchronously), so it is safe to drive from the
  // mount effect. Reused by "Review next", which always recomputes the global earliest-due Work.
  const load = useCallback((work?: string) => {
    fetchRecitationReview(work).then(
      (response) => setState({ review: response.review, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, []);

  useEffect(() => {
    load(workEntryId);
  }, [load, workEntryId]);

  // "Review next": show the loader, then reload the global earliest-due Work. The next Work never opens on
  // its own — the learner chooses it here.
  function reviewNext(): void {
    setState({ status: "loading" });
    load();
  }

  return (
    <section aria-labelledby="recitation-heading" className="mx-auto max-w-2xl p-6">
      <p className="mb-4">
        <Link className="text-sm text-text-muted underline" to="/recite">
          Back to Recite
        </Link>
      </p>
      <h1 className="text-xl font-semibold text-text" id="recitation-heading">
        Recitation
      </h1>
      <div className="mt-4">{renderState(state, setState, reviewNext)}</div>
    </section>
  );
}

function renderState(
  state: ReviewState,
  setState: (next: ReviewState) => void,
  onReviewNext: () => void
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Loading your recitation…" />;
  }
  if (state.status === "error") {
    return (
      <p className="text-text-muted" role="alert">
        Couldn&rsquo;t load your recitation right now. Please try again.
      </p>
    );
  }
  if (state.status === "done") {
    return <ScheduledState onReviewNext={onReviewNext} state={state} />;
  }
  if (state.review === null) {
    return <NothingDueState />;
  }
  return (
    <RecitationReviewCard
      onReviewed={(response) =>
        setState({
          remainingDueCount: response.remainingDueCount,
          scheduled: response.review,
          status: "done"
        })
      }
      review={state.review}
    />
  );
}

// Nothing is due (or the Work is not enrolled / was paused or removed): a restrained recovery that points
// back to the Library rather than opening a dead screen.
function NothingDueState(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-muted">
        No recitation is due right now. Open a Work in your Library and choose &ldquo;I can recite
        this&rdquo; to start maintaining it.
      </p>
      <Link className={buttonVariants({ variant: "secondary" })} to="/library">
        Go to Library
      </Link>
    </div>
  );
}

// After a rating: confirm the Work's next scheduled review, then — from the canonical remaining-due count
// (#637) — either offer an OPTIONAL "Review next" (while other Works are due; it never opens the next Work
// automatically) or announce "Due complete". Either way a clear way back to Today is always present.
function ScheduledState({
  onReviewNext,
  state
}: Readonly<{
  onReviewNext: () => void;
  state: Readonly<{ remainingDueCount: number; scheduled: RecitationReviewDto }>;
}>): React.JSX.Element {
  const moreDue = state.remainingDueCount > 0;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text" role="status">
        Scheduled <span className="font-medium">{state.scheduled.workTitle}</span>. Next review on{" "}
        {state.scheduled.dueAt.slice(0, 10)}.
      </p>
      {moreDue ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onReviewNext} size="sm" variant="primary">
            Review next
          </Button>
          <Link className={buttonVariants({ variant: "secondary" })} to="/">
            Back to Today
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="font-medium text-text">Due complete.</p>
          <Link className={buttonVariants({ variant: "secondary" })} to="/">
            Back to Today
          </Link>
        </div>
      )}
    </div>
  );
}
