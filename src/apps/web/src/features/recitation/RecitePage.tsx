import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { RecitationOverviewDto, RecitationOverviewWorkDto } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { PageFrame } from "../../shared/ui/PageFrame";
import { fetchRecitationOverview } from "./reciteOverviewApi";

type OverviewState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ overview: RecitationOverviewDto; status: "ready" }>;

// Format a card's next review instant as a calm, human date the learner reads on the Recite home.
function formatReviewDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric"
  });
}

// The Recite home (#638): the primary destination for whole-Work recitation maintenance. It lists every
// enrolled Work with its live due state and next review date read from the server, leads with a due-review
// entry when anything is due, and points to each Work's direct maintenance review (a secondary surface
// under Recite). Enrollment happens in Library/Reader ("I can recite this"), so the empty state points
// there rather than inventing an enrol action here.
export function RecitePage(): React.JSX.Element {
  const [state, setState] = useState<OverviewState>({ status: "loading" });

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

  return (
    <PageFrame title="Recite">
      {renderState(state)}
    </PageFrame>
  );
}

function renderState(state: OverviewState): React.JSX.Element {
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
  return <OverviewView overview={state.overview} />;
}

function OverviewView({
  overview
}: Readonly<{ overview: RecitationOverviewDto }>): React.JSX.Element {
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
          <WorkRow key={work.planEntryId} work={work} />
        ))}
      </ul>
    </div>
  );
}

// Turn one enrolled Work's live state into the calm, human status the learner reads: due now, paused, its
// next review date, or — when maintenance was removed but the plan remains — not scheduled.
function workStatusLabel(work: RecitationOverviewWorkDto): string {
  if (work.paused) {
    return "Paused";
  }
  if (work.isDue) {
    return "Due now";
  }
  if (work.nextReviewAt === null) {
    return "Not scheduled";
  }
  return `Next review ${formatReviewDate(work.nextReviewAt)}`;
}

function WorkRow({ work }: Readonly<{ work: RecitationOverviewWorkDto }>): React.JSX.Element {
  return (
    <li>
      <Link
        className="flex items-center justify-between gap-3 rounded border border-border p-3 hover:border-accent"
        to={`/recitation?work=${encodeURIComponent(work.workEntryId)}`}
      >
        <span className="font-medium text-text">{work.workTitle}</span>
        <span className="text-sm text-text-muted">{workStatusLabel(work)}</span>
      </Link>
    </li>
  );
}
