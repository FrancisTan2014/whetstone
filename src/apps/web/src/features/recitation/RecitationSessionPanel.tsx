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

// The complete inline recitation session (#609/#633): one focused step at a time over the GLOBAL routine,
// recomputed from canonical server state after each action. The routine aggregates every unpaused plan,
// so once the current Work's required items clear it advances to the next Work automatically. The panel
// pins the Work it is currently showing so a rating never context-switches mid-Work (#633 AC4); the only
// other local state is transient presentation state — a dismissed chain rehearsal and a skipped optional
// introduction — reset whenever the routine advances to a new Work.
export function RecitationSessionPanel({
  onExit,
  planEntryId
}: Readonly<{ onExit?: () => void; planEntryId: string }>): React.JSX.Element {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  // Bumped on every canonical reload so the mounted step remounts and re-fetches its own step-local
  // data. Without it, a step that stays selected after an action (another due passage remains, or a
  // just-started chain) keeps its stale fetch and never drains — its effect keys only on planEntryId.
  const [reloadNonce, setReloadNonce] = useState(0);

  function load(pinnedPlanEntryId: string): void {
    getRecitationSession(pinnedPlanEntryId).then(
      (session) => setState({ session, status: "ready" }),
      () => setState({ status: "error" })
    );
  }

  useEffect(() => load(planEntryId), [planEntryId]);

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

  // The active session is now narrowed, so the pinned Work id is always concrete: a reload advances
  // within the shown Work, not to another Work, until it is fully clear — then the aggregate hands the
  // routine to the next Work.
  const activeSession = state.session;
  function reload(): void {
    setReloadNonce((nonce) => nonce + 1);
    load(activeSession.planEntryId);
  }

  return (
    // Keying by the selected Work resets the transient per-Work presentation state (a dismissed chain
    // rehearsal, a skipped or introduced optional passage) by remounting whenever the aggregate advances
    // to a different Work — no setState-in-effect. A same-Work reload keeps the same key, so that
    // transient state correctly persists across it (#633).
    <ActiveSessionPanel
      key={activeSession.planEntryId}
      onExit={onExit}
      onReload={reload}
      planEntryId={activeSession.planEntryId}
      reloadNonce={reloadNonce}
      session={activeSession}
    />
  );
}

function ActiveSessionPanel({
  onExit,
  onReload,
  planEntryId,
  reloadNonce,
  session
}: Readonly<{
  onExit: (() => void) | undefined;
  onReload: () => void;
  planEntryId: string;
  reloadNonce: number;
  session: ActiveSession;
}>): React.JSX.Element {
  const [chainDismissed, setChainDismissed] = useState(false);
  const [newPassageIntroduced, setNewPassageIntroduced] = useState(false);
  const [newPassageSkipped, setNewPassageSkipped] = useState(false);

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
        <DuePassageStep
          key={`due-${reloadNonce}`}
          onReviewed={onReload}
          planEntryId={planEntryId}
        />
      ) : displayedStep === "whole_work" ? (
        <MaintenanceStep
          key={`whole-${reloadNonce}`}
          mode="whole_work"
          onAction={onReload}
          planEntryId={planEntryId}
        />
      ) : displayedStep === "chain" ? (
        <MaintenanceStep
          key={`chain-${reloadNonce}`}
          mode="chain"
          onAction={onReload}
          onDismissChain={() => setChainDismissed(true)}
          planEntryId={planEntryId}
        />
      ) : displayedStep === "new_passage" ? (
        <NewPassageStep
          onIntroduced={() => {
            setNewPassageIntroduced(true);
            setNewPassageSkipped(false);
            onReload();
          }}
          onSkip={() => setNewPassageSkipped(true)}
          planEntryId={planEntryId}
        />
      ) : (
        <CompletionStep
          newPassageAvailable={session.newPassage.available}
          onIntroduced={() => {
            setNewPassageIntroduced(true);
            setNewPassageSkipped(false);
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

  function runAction(action: Promise<unknown>, onSuccess: () => void = onAction): void {
    setActionFailed(false);
    action.then(onSuccess, () => setActionFailed(true));
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
              onComplete={(outcome) =>
                // Completing the active chain ends the chain step for this session pass. Without this the
                // still-owned prefix stays chain-eligible and the session would re-offer a fresh chain
                // start forever instead of advancing to the next step (#609).
                runAction(completeChain(activeChain.chainId, outcome), () => {
                  props.onDismissChain();
                  onAction();
                })
              }
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
