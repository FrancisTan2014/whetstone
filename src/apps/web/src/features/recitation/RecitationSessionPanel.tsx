import { useEffect, useState } from "react";

import type {
  DueRecitationPassageDto,
  RecitationChainingDto,
  RecitationPassageDto,
  RecitationSessionDto
} from "@whetstone/contracts";
import { selectRecitationSessionStep } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { ActiveChain, ChainStart, WholeWork } from "./RecitationChainingPanel";
import { RecitationReviewCard } from "./RecitationReviewCard";
import { PassageIntroductionPanel } from "./RecitePage";
import { completeChain, fetchChaining, reviewWholeWork, startChain } from "./recitationChainingApi";
import { fetchDuePassageForPlan, listPassages } from "./recitationPassageApi";
import { getRecitationSession } from "./recitationSessionApi";

type SessionState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ session: RecitationSessionDto; status: "ready" }>;

type ActiveSession = Extract<RecitationSessionDto, { status: "active" }>;

// The complete inline recitation session (#609): one focused step at a time, recomputed from canonical
// server state after each action. The only local state is transient presentation state — a dismissed
// chain rehearsal and a skipped optional introduction — so ratings and evidence still persist
// immediately through the existing passage/chain/whole-work commands.
export function RecitationSessionPanel({
  onExit,
  planEntryId
}: Readonly<{ onExit?: () => void; planEntryId: string }>): React.JSX.Element {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const [chainDismissed, setChainDismissed] = useState(false);
  const [newPassageIntroduced, setNewPassageIntroduced] = useState(false);
  const [newPassageSkipped, setNewPassageSkipped] = useState(false);

  function load(): void {
    getRecitationSession().then(
      (session) => setState({ session, status: "ready" }),
      () => setState({ status: "error" })
    );
  }

  useEffect(load, [planEntryId]);

  if (state.status === "loading") {
    return <LoadingIndicator label="Loading recitation session…" />;
  }
  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load the recitation session. Please try again.
      </p>
    );
  }
  if (state.session.status === "no_plan") {
    return <p className="text-text-muted">No recitation routine is ready.</p>;
  }

  return (
    <ActiveSessionPanel
      chainDismissed={chainDismissed}
      newPassageIntroduced={newPassageIntroduced}
      newPassageSkipped={newPassageSkipped}
      onChainDismissed={() => setChainDismissed(true)}
      onExit={onExit}
      onReload={load}
      onSessionIntroducedNewPassage={() => setNewPassageIntroduced(true)}
      onSkipNewPassage={() => setNewPassageSkipped(true)}
      onUseNewPassage={() => setNewPassageSkipped(false)}
      planEntryId={planEntryId}
      session={state.session}
    />
  );
}

function ActiveSessionPanel({
  chainDismissed,
  newPassageIntroduced,
  newPassageSkipped,
  onChainDismissed,
  onExit,
  onReload,
  onSessionIntroducedNewPassage,
  onSkipNewPassage,
  onUseNewPassage,
  planEntryId,
  session
}: Readonly<{
  chainDismissed: boolean;
  newPassageIntroduced: boolean;
  newPassageSkipped: boolean;
  onChainDismissed: () => void;
  onExit: (() => void) | undefined;
  onReload: () => void;
  onSessionIntroducedNewPassage: () => void;
  onSkipNewPassage: () => void;
  onUseNewPassage: () => void;
  planEntryId: string;
  session: ActiveSession;
}>): React.JSX.Element {
  const displayedStep = selectRecitationSessionStep({
    chainAvailable: session.chainAvailable && !chainDismissed,
    hasDuePassage: session.hasDuePassage,
    newPassageAvailable:
      session.newPassage.available && !newPassageSkipped && !newPassageIntroduced,
    wholeWorkDue: session.wholeWorkDue
  });

  return (
    <section aria-label="Recitation session" className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-text-muted">Session for</p>
        <h3 className="text-lg font-semibold text-text">{session.workTitle}</h3>
      </div>

      {displayedStep === "due_passage" ? (
        <DuePassageStep onReviewed={onReload} planEntryId={planEntryId} />
      ) : displayedStep === "whole_work" ? (
        <MaintenanceStep mode="whole_work" onAction={onReload} planEntryId={planEntryId} />
      ) : displayedStep === "chain" ? (
        <MaintenanceStep
          mode="chain"
          onAction={onReload}
          onDismissChain={onChainDismissed}
          planEntryId={planEntryId}
        />
      ) : displayedStep === "new_passage" ? (
        <NewPassageStep
          onIntroduced={() => {
            onSessionIntroducedNewPassage();
            onUseNewPassage();
            onReload();
          }}
          onSkip={onSkipNewPassage}
          planEntryId={planEntryId}
        />
      ) : (
        <CompletionStep
          newPassageAvailable={session.newPassage.available}
          onIntroduced={() => {
            onSessionIntroducedNewPassage();
            onUseNewPassage();
            onReload();
          }}
          planEntryId={planEntryId}
        />
      )}

      {onExit === undefined ? null : (
        <div>
          <Button onClick={onExit} variant="ghost">
            Exit session
          </Button>
        </div>
      )}
    </section>
  );
}

type DuePassageState =
  | Readonly<{ status: "empty" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ passage: DueRecitationPassageDto; status: "reviewing" }>;

function DuePassageStep({
  onReviewed,
  planEntryId
}: Readonly<{ onReviewed: () => void; planEntryId: string }>): React.JSX.Element {
  const [state, setState] = useState<DuePassageState>({ status: "loading" });

  useEffect(() => {
    fetchDuePassageForPlan(planEntryId).then(
      (passage) =>
        setState(passage === null ? { status: "empty" } : { passage, status: "reviewing" }),
      () => setState({ status: "error" })
    );
  }, [planEntryId]);

  if (state.status === "loading") {
    return <LoadingIndicator label="Finding your next passage…" />;
  }
  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load your due passage. Please try again.
      </p>
    );
  }
  if (state.status === "empty") {
    return <p className="text-text-muted">That due passage is already clear.</p>;
  }

  return (
    <RecitationReviewCard
      key={state.passage.passageEntryId}
      onReviewed={onReviewed}
      passage={state.passage}
    />
  );
}

type MaintenanceState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{
      chaining: RecitationChainingDto;
      passages: ReadonlyArray<RecitationPassageDto>;
      status: "ready";
    }>;

type MaintenanceStepProps =
  | Readonly<{
      mode: "chain";
      onAction: () => void;
      onDismissChain: () => void;
      planEntryId: string;
    }>
  | Readonly<{
      mode: "whole_work";
      onAction: () => void;
      planEntryId: string;
    }>;

function MaintenanceStep(props: MaintenanceStepProps): React.JSX.Element {
  const {
    onAction,
    planEntryId
  }: Readonly<{
    onAction: () => void;
    planEntryId: string;
  }> = props;
  const [state, setState] = useState<MaintenanceState>({ status: "loading" });
  const [actionFailed, setActionFailed] = useState(false);

  function load(): void {
    Promise.all([fetchChaining(planEntryId), listPassages(planEntryId)]).then(
      ([chaining, list]) => setState({ chaining, passages: list.passages, status: "ready" }),
      () => setState({ status: "error" })
    );
  }

  useEffect(load, [planEntryId]);

  function runAction(action: Promise<unknown>): void {
    setActionFailed(false);
    action.then(onAction, () => setActionFailed(true));
  }

  if (state.status === "loading") {
    return <LoadingIndicator label="Loading maintenance…" />;
  }
  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load this session step. Please try again.
      </p>
    );
  }
  const activeChain = state.chaining.activeChain;

  return (
    <div className="flex flex-col gap-3">
      {actionFailed ? (
        <p className="text-danger" role="alert">
          Could not update this session step. Please try again.
        </p>
      ) : null}
      {props.mode === "whole_work" ? (
        <WholeWork
          due={state.chaining.wholeWork.due}
          exists={state.chaining.wholeWork.exists}
          onReview={(rating, outcome) => runAction(reviewWholeWork(planEntryId, rating, outcome))}
          passages={state.passages}
        />
      ) : (
        <>
          {activeChain === null ? (
            <ChainStart
              eligibility={state.chaining.chainEligibility}
              onStart={(endOrderIndex) => runAction(startChain(planEntryId, endOrderIndex))}
            />
          ) : (
            <ActiveChain
              chain={activeChain}
              onComplete={(outcome) => runAction(completeChain(activeChain.chainId, outcome))}
            />
          )}
          <div>
            <Button onClick={props.onDismissChain} variant="ghost">
              Done with chains
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function NewPassageStep({
  onIntroduced,
  onSkip,
  planEntryId
}: Readonly<{
  onIntroduced: () => void;
  onSkip: () => void;
  planEntryId: string;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <PassageIntroductionPanel onIntroduced={onIntroduced} planEntryId={planEntryId} />
      <div>
        <Button onClick={onSkip} variant="ghost">
          Skip new passage for now
        </Button>
      </div>
    </div>
  );
}

function CompletionStep({
  newPassageAvailable,
  onIntroduced,
  planEntryId
}: Readonly<{
  newPassageAvailable: boolean;
  onIntroduced: () => void;
  planEntryId: string;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3" role="status">
      <p className="text-text">Due recitation clear</p>
      {newPassageAvailable ? (
        <PassageIntroductionPanel onIntroduced={onIntroduced} planEntryId={planEntryId} />
      ) : null}
    </div>
  );
}
