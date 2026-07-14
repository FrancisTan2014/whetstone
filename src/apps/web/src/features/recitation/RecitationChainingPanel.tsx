import { useEffect, useState } from "react";

import type {
  RecitationChainDto,
  RecitationChainingDto,
  RecitationPassageDto,
  RecitationReviewRating
} from "@whetstone/contracts";
import { recitationRatingChoices } from "@whetstone/domain";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { completeChain, fetchChaining, reviewWholeWork, startChain } from "./recitationChainingApi";
import { listPassages } from "./recitationPassageApi";

type ChainingState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{
      chaining: RecitationChainingDto;
      passages: ReadonlyArray<RecitationPassageDto>;
      status: "ready";
    }>;

// The maintenance surface for one recitation plan (#580): once passages are owned in a contiguous run
// from the start, the learner can recite them as a chain to practise the transitions, and once every
// passage is owned, keep the whole work alive with a single aggregate prompt on its own schedule. This
// never grades a passage implicitly — only a passage the learner explicitly identifies as broken gets an
// Again. It reads its progress from the server (owned prefix, eligibility, the active chain) and reloads
// after each action; nothing here is a Timeline Entry.
export function RecitationChainingPanel({
  planEntryId
}: Readonly<{ planEntryId: string }>): React.JSX.Element {
  const [state, setState] = useState<ChainingState>({ status: "loading" });
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
    action.then(
      () => load(),
      () => setActionFailed(true)
    );
  }

  if (state.status === "loading") {
    return <LoadingIndicator label="Loading maintenance…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load recitation maintenance. Please try again.
      </p>
    );
  }

  const { chaining, passages } = state;
  const activeChain = chaining.activeChain;

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-text">Maintenance</h2>
      {actionFailed ? (
        <p className="text-danger" role="alert">
          Could not update. Please try again.
        </p>
      ) : null}

      <p className="text-text-muted">
        Owned from the start: {chaining.ownedPrefix.ownedCount} of {chaining.ownedPrefix.total}{" "}
        {chaining.ownedPrefix.total === 1 ? "passage" : "passages"} in a row.
      </p>

      {activeChain === null ? (
        <ChainStart
          eligibility={chaining.chainEligibility}
          onStart={(endOrderIndex) => runAction(startChain(planEntryId, endOrderIndex))}
        />
      ) : (
        <ActiveChain
          chain={activeChain}
          onComplete={(outcome) => runAction(completeChain(activeChain.chainId, outcome))}
        />
      )}

      {chaining.wholeWorkOwned || chaining.wholeWork.exists ? (
        <WholeWork
          exists={chaining.wholeWork.exists}
          due={chaining.wholeWork.due}
          passages={passages}
          onReview={(rating, outcome) => runAction(reviewWholeWork(planEntryId, rating, outcome))}
        />
      ) : null}
    </div>
  );
}

// Offer to start a contiguous chain when adjacent owned passages exist. The learner chooses the end
// boundary (a 0-based passage index within the owned prefix); the start is always the first passage and
// nothing inside can be skipped, so a chain is at least two passages.
export function ChainStart({
  eligibility,
  onStart
}: Readonly<{
  eligibility: RecitationChainingDto["chainEligibility"];
  onStart: (endOrderIndex: number) => void;
}>): React.JSX.Element {
  const maxEndIndex = eligibility.status === "eligible" ? eligibility.maxEndIndex : 0;
  const [endOrderIndex, setEndOrderIndex] = useState(maxEndIndex);

  if (eligibility.status !== "eligible") {
    return (
      <p className="text-text-muted">
        Own the first two passages to start reciting them as a chain.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col text-sm text-text-muted">
        Chain through passage
        <input
          className="mt-1 w-20 rounded border border-border bg-bg px-2 py-1 text-text"
          max={maxEndIndex + 1}
          min={2}
          onChange={(event) => setEndOrderIndex(Number(event.target.value) - 1)}
          type="number"
          value={endOrderIndex + 1}
        />
      </label>
      <Button onClick={() => onStart(endOrderIndex)} variant="primary">
        Start chain
      </Button>
    </div>
  );
}

// An in-progress chain: the contiguous passages in fixed order. After reciting, the learner reports the
// recall either held throughout, or broke at one identified passage — only that passage is failed.
export function ActiveChain({
  chain,
  onComplete
}: Readonly<{
  chain: RecitationChainDto;
  onComplete: (outcome: { passageEntryId: string; status: "broke" } | { status: "held" }) => void;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-muted">
        Recite these {chain.passages.length} passages in order, then say where recall broke.
      </p>
      <ol aria-label="Chain passages" className="flex flex-col gap-2">
        {chain.passages.map((passage) => (
          <li className="rounded border border-border bg-surface p-3" key={passage.passageEntryId}>
            <p className="text-text">{passage.sourceText}</p>
            <Button
              className="mt-2"
              onClick={() =>
                onComplete({ passageEntryId: passage.passageEntryId, status: "broke" })
              }
              size="sm"
              variant="ghost"
            >
              Recall broke here
            </Button>
          </li>
        ))}
      </ol>
      <div>
        <Button onClick={() => onComplete({ status: "held" })} variant="primary">
          Recall held throughout
        </Button>
      </div>
    </div>
  );
}

// The whole-work maintenance prompt: a single aggregate recall over the entire work, scheduled by its own
// FSRS state. Rating it Again reschedules only this prompt; a passage is reset only if the learner
// identifies it as the break point.
export function WholeWork({
  due,
  exists,
  onReview,
  passages
}: Readonly<{
  due: boolean;
  exists: boolean;
  onReview: (
    rating: RecitationReviewRating,
    outcome: { passageEntryId: string; status: "broke" } | { status: "held" }
  ) => void;
  passages: ReadonlyArray<RecitationPassageDto>;
}>): React.JSX.Element {
  const [brokeAt, setBrokeAt] = useState<string | null>(null);

  const outcome =
    brokeAt === null
      ? ({ status: "held" } as const)
      : ({ passageEntryId: brokeAt, status: "broke" } as const);

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-base font-semibold text-text">Whole-work maintenance</h3>
      <p className="text-text-muted">
        {exists
          ? due
            ? "Recite the whole work from memory, then rate it."
            : "The whole work is scheduled; it is not due yet."
          : "Every passage is owned. Start maintaining the whole work."}
      </p>
      {passages.length > 0 && (
        <label className="flex flex-col text-sm text-text-muted">
          Recall broke at
          <select
            className="mt-1 rounded border border-border bg-bg px-2 py-1 text-text"
            onChange={(event) => setBrokeAt(event.target.value === "" ? null : event.target.value)}
            value={brokeAt ?? ""}
          >
            <option value="">Recall held throughout</option>
            {passages.map((passage) => (
              <option key={passage.entryId} value={passage.entryId}>
                {passage.sourceText}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {recitationRatingChoices.map((choice) => (
          <Button
            key={choice.rating}
            onClick={() => onReview(choice.rating, outcome)}
            size="sm"
            variant="secondary"
          >
            {choice.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
