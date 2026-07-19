import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { RecitationOverviewDto, RecitationOverviewWorkDto } from "@whetstone/contracts";
import { formatNextReviewLabel } from "@whetstone/domain";

import { buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { PageFrame } from "../../shared/ui/PageFrame";
import { useLearnerTimeZone } from "../../shared/preferences/useLearnerTimeZone";
import { fetchRecitationOverview } from "./reciteOverviewApi";

type OverviewState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ overview: RecitationOverviewDto; status: "ready" }>;

// The Recite home (#638): the primary destination for whole-Work recitation maintenance. It lists every
// enrolled Work with its live due state and next review date read from the server, leads with a due-review
// entry when anything is due, and points to each Work's direct maintenance review (a secondary surface
// under Recite). Enrollment happens in Library/Reader ("I can recite this"), so the empty state points
// there rather than inventing an enrol action here.
export function RecitePage(): React.JSX.Element {
  const [state, setState] = useState<OverviewState>({ status: "loading" });
  // The learner's persisted zone (#676): each Work row resolves its next-review label in it.
  const timeZone = useLearnerTimeZone();

  // Defer the state transition through the promise's callbacks (never a synchronous set in the effect
  // body), the same loader shape the review page uses.
  const load = useCallback(() => {
    fetchRecitationOverview().then(
      (overview) => setState({ overview, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return <PageFrame title="Recite">{renderState(state, timeZone)}</PageFrame>;
}

function renderState(state: OverviewState, timeZone: string): React.JSX.Element {
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
  return <OverviewView overview={state.overview} timeZone={timeZone} />;
}

function OverviewView({
  overview,
  timeZone
}: Readonly<{ overview: RecitationOverviewDto; timeZone: string }>): React.JSX.Element {
  if (overview.works.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-text-muted">
          You haven&rsquo;t enrolled any Works yet. Open a Work in your Library and choose &ldquo;I
          can recite this&rdquo; to begin maintaining it.
        </p>
        <Link className={buttonVariants({ variant: "secondary" })} to="/library">
          Go to Library
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {overview.dueCount > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-text" role="status">
            {overview.dueCount === 1
              ? "1 Work is due for review."
              : `${overview.dueCount} Works are due for review.`}
          </p>
          <Link className={buttonVariants({ variant: "primary", size: "sm" })} to="/recitation">
            Start due review
          </Link>
        </div>
      ) : (
        <p className="text-text-muted" role="status">
          Nothing is due right now.
        </p>
      )}
      <ul aria-label="Enrolled Works" className="flex flex-col gap-2">
        {overview.works.map((work) => (
          <WorkRow key={work.planEntryId} timeZone={timeZone} work={work} />
        ))}
      </ul>
    </div>
  );
}

// Turn one enrolled Work's live state into the calm, human status the learner reads: due now, paused, its
// next review time, or — when maintenance was removed but the plan remains — not scheduled. The scheduled
// when-phrase is the ONE shared next-review projection (#676), resolved in the learner's zone.
function workStatusLabel(work: RecitationOverviewWorkDto, now: Date, timeZone: string): string {
  if (work.paused) {
    return "Paused";
  }
  if (work.isDue) {
    return "Due now";
  }
  if (work.nextReviewAt === null) {
    return "Not scheduled";
  }
  return `Next review ${formatNextReviewLabel({ due: new Date(work.nextReviewAt), now, timeZone })}`;
}

function WorkRow({
  timeZone,
  work
}: Readonly<{ timeZone: string; work: RecitationOverviewWorkDto }>): React.JSX.Element {
  return (
    <li>
      <Link
        className="flex items-center justify-between gap-3 rounded border border-border p-3 hover:border-accent"
        to={`/recitation?work=${encodeURIComponent(work.workEntryId)}`}
      >
        <span className="font-medium text-text">{work.workTitle}</span>
        <span className="text-sm text-text-muted">
          {workStatusLabel(work, new Date(), timeZone)}
        </span>
      </Link>
    </li>
  );
}
