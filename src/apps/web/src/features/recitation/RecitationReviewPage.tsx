import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { RecitationReviewDto } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { fetchRecitationReview } from "./recitationApi";
import { RecitationReviewCard } from "./RecitationReviewCard";

type ReviewState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ review: RecitationReviewDto | null; status: "ready" }>
  | Readonly<{ scheduled: RecitationReviewDto; status: "done" }>;

// The direct Recitation maintenance page (#643): it opens ONE whole-Work review. With `?work=<id>` it
// opens THAT exact Work's review (the review right after "I can recite this"); without it, the earliest-
// due Work. When nothing is due — or the Work is not enrolled / was paused or removed — it shows a calm
// recovery pointing back to the Library, never a dead or misleading screen. After a rating it confirms
// the next scheduled review and offers a return to Today. There is NO passage, chain, phase, or session
// surface — those are retired (#643).
export function RecitationReviewPage({
  workEntryId
}: Readonly<{ workEntryId?: string | undefined }> = {}): React.JSX.Element {
  const [state, setState] = useState<ReviewState>({ status: "loading" });

  useEffect(() => {
    fetchRecitationReview(workEntryId).then(
      (response) => setState({ review: response.review, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, [workEntryId]);

  return (
    <section aria-labelledby="recitation-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold text-text" id="recitation-heading">
        Recitation
      </h1>
      <div className="mt-4">{renderState(state, setState)}</div>
    </section>
  );
}

function renderState(
  state: ReviewState,
  setState: (next: ReviewState) => void
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
    return <ScheduledState scheduled={state.scheduled} />;
  }
  if (state.review === null) {
    return <NothingDueState />;
  }
  return (
    <RecitationReviewCard
      onReviewed={(next) => setState({ scheduled: next, status: "done" })}
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

// After a rating: confirm the Work's next scheduled review and offer a return to Today.
function ScheduledState({
  scheduled
}: Readonly<{ scheduled: RecitationReviewDto }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text" role="status">
        Scheduled <span className="font-medium">{scheduled.workTitle}</span>. Next review on{" "}
        {scheduled.dueAt.slice(0, 10)}.
      </p>
      <Link className={buttonVariants({ variant: "secondary" })} to="/">
        Back to Today
      </Link>
    </div>
  );
}
