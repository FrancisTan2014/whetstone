import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { RecitationHubDto } from "@whetstone/contracts";

import { Button, buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { getRecitationHub, pausePlan, resumePlan } from "./recitationHubApi";
import { recitationPhaseLabels } from "./recitationLabels";
import { recitationPrimaryActionLabels, recitationStageLabels } from "./RecitationHubPage.tokens";

type HubState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ hub: RecitationHubDto; status: "ready" }>;

type ActiveHub = Extract<RecitationHubDto, { status: "active" }>;

// The recitation routine hub (#608): one calm, single-column projection answering what needs attention
// now, where the learner is in this Work, and the next available action. It renders explicit states —
// loading, error, no-plan, active (with paused/caught-up variants) — and never flashes a contradictory
// action while data resolves. It owns no progress: everything shown comes from the server projection,
// and pause/resume simply refresh it. There is NO dashboard grid, streak, score, heatmap, or chart.
export function RecitationHubPage(): React.JSX.Element {
  const [state, setState] = useState<HubState>({ status: "loading" });
  // A transient failure of a pause/resume action, surfaced inline without blanking the resolved hub.
  const [mutationFailed, setMutationFailed] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    getRecitationHub().then(
      (hub) => setState({ hub, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, []);

  function runMutation(action: Promise<RecitationHubDto>): void {
    setMutationFailed(false);
    setPending(true);
    action.then(
      (hub) => {
        setState({ hub, status: "ready" });
        setPending(false);
      },
      () => {
        setMutationFailed(true);
        setPending(false);
      }
    );
  }

  return (
    <section aria-labelledby="recitation-hub-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-xl font-semibold text-text" id="recitation-hub-heading">
        Recitation
      </h1>
      <div className="mt-4">{renderState(state, mutationFailed, pending, runMutation)}</div>
    </section>
  );
}

function renderState(
  state: HubState,
  mutationFailed: boolean,
  pending: boolean,
  runMutation: (action: Promise<RecitationHubDto>) => void
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
  if (state.hub.status === "no_plan") {
    return <NoPlanState />;
  }
  return (
    <ActivePlanView
      hub={state.hub}
      mutationFailed={mutationFailed}
      pending={pending}
      runMutation={runMutation}
    />
  );
}

// No adopted plan: a restrained empty state that points to the Library to choose a Work, preview it, and
// adopt it. No demo data, no fabricated progress.
function NoPlanState(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-muted">
        You have no recitation routine yet. Choose a Work in your Library, preview it, and adopt it
        to begin.
      </p>
      <Link className={buttonVariants({ variant: "secondary" })} to="/library">
        Go to Library
      </Link>
    </div>
  );
}

function ActivePlanView({
  hub,
  mutationFailed,
  pending,
  runMutation
}: Readonly<{
  hub: ActiveHub;
  mutationFailed: boolean;
  pending: boolean;
  runMutation: (action: Promise<RecitationHubDto>) => void;
}>): React.JSX.Element {
  const reciteHref = `#/recite?plan=${encodeURIComponent(hub.planEntryId)}`;
  const primaryLabel =
    hub.primaryAction === "none" ? null : recitationPrimaryActionLabels[hub.primaryAction];
  const caughtUp =
    !hub.paused && hub.primaryAction === "none" && !hub.introduction.newPassageAvailable;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-lg font-medium text-text">{hub.workTitle}</h2>
        <p className="text-sm text-text-muted">
          {hub.paused ? "Paused" : recitationPhaseLabels[hub.phase]}
        </p>
      </div>

      {hub.paused ? (
        <div
          aria-label="Paused routine"
          className="rounded border border-border bg-surface p-4"
          role="note"
        >
          <p className="text-text-muted">
            This routine is paused. Your progress, schedule, and history are kept — resume when you
            are ready.
          </p>
          <Button
            className="mt-3"
            disabled={pending}
            onClick={() => runMutation(resumePlan(hub.planEntryId))}
            variant="primary"
          >
            Resume routine
          </Button>
        </div>
      ) : null}

      <p className="text-text">
        {hub.passages.introducedCount} of {hub.passages.totalCount} passages introduced
      </p>

      <p className="text-sm text-text-muted">Stage: {recitationStageLabels[hub.stage]}</p>

      {primaryLabel !== null ? (
        <div aria-label="Due review" className="flex flex-col gap-2" role="group">
          <p className="text-text">
            {hub.due.dueCount} due
            {hub.due.overdueCount > 0 ? ` · ${hub.due.overdueCount} overdue` : ""}
          </p>
          <a className={buttonVariants({ variant: "primary" })} href={reciteHref}>
            {primaryLabel}
          </a>
        </div>
      ) : null}

      {!hub.paused && hub.introduction.newPassageAvailable ? (
        <div aria-label="New passage" className="flex flex-col gap-2" role="group">
          <p className="text-sm text-text-muted">
            {hub.introduction.introducedToday} of {hub.introduction.dailyCap} introduced today
            {hub.introduction.remainingCapacity > 0
              ? ` · ${hub.introduction.remainingCapacity} left`
              : ""}
          </p>
          <a className={buttonVariants({ variant: "secondary" })} href={reciteHref}>
            {hub.introduction.anyIntroduced ? "New passage" : "Start first passage"}
          </a>
        </div>
      ) : null}

      {caughtUp ? (
        <div aria-label="Caught up" className="flex flex-col gap-2" role="group">
          <p className="text-text-muted">You&rsquo;re caught up for today.</p>
          <a className={buttonVariants({ variant: "ghost" })} href={reciteHref}>
            Open routine
          </a>
        </div>
      ) : null}

      {mutationFailed ? (
        <p className="text-text-muted" role="alert">
          Couldn&rsquo;t update the routine. Please try again.
        </p>
      ) : null}

      {hub.paused ? null : (
        <Button
          disabled={pending}
          onClick={() => runMutation(pausePlan(hub.planEntryId))}
          variant="secondary"
        >
          Pause routine
        </Button>
      )}
    </div>
  );
}
