import { useEffect, useState } from "react";

import type { RecitationIntroductionStatusDto, RecitationPassageDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import {
  getIntroductionStatus,
  introduceNextPassage,
  listPassages,
  mergeNextPassage,
  seedPassages,
  splitPassage
} from "./recitationPassageApi";
import { RecitationChainingPanel } from "./RecitationChainingPanel";

type PassagesState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ passages: ReadonlyArray<RecitationPassageDto>; status: "ready" }>;

// The passage segmentation + progress surface for one recitation plan (#578). A learner divides the
// plan's Work into contiguous passages (seed), then edits the boundaries — split a passage at a character
// position, or merge one with the next — without ever changing the canonical Work text. Each passage's
// review progress is shown here (the plan's practice history); the actual due practice happens on Today.
// Boundary edits reset that passage's schedule, so this is a Learning-phase setup activity, kept calm and
// off the reader. Introduction of new passages is explicit and paced by the introduction panel (#607).
export function RecitePage({
  planEntryId
}: Readonly<{ planEntryId?: string | undefined }>): React.JSX.Element {
  const [state, setState] = useState<PassagesState>(
    planEntryId === undefined ? { passages: [], status: "ready" } : { status: "loading" }
  );
  const [actionFailed, setActionFailed] = useState(false);
  // Bumped whenever an introduction activates a passage, so the list re-fetches to show the new card.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (planEntryId === undefined) {
      return;
    }
    listPassages(planEntryId).then(
      (list) => setState({ passages: list.passages, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, [planEntryId, reloadToken]);

  function runAction(action: Promise<ReadonlyArray<RecitationPassageDto>>): void {
    setActionFailed(false);
    action.then(
      (passages) => setState({ passages, status: "ready" }),
      () => setActionFailed(true)
    );
  }

  if (planEntryId === undefined) {
    return (
      <PageFrame>
        <p className="text-text-muted">Open a recitation routine from your Library to divide it.</p>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      {actionFailed ? (
        <p className="mt-4 text-danger" role="alert">
          Could not update the passages. Please try again.
        </p>
      ) : null}
      {state.status === "ready" && state.passages.length > 0 ? (
        <div className="mt-6">
          <PassageIntroductionPanel
            onIntroduced={() => setReloadToken((token) => token + 1)}
            planEntryId={planEntryId}
          />
        </div>
      ) : null}
      <div className="mt-6">
        {renderBody(
          state,
          () => runAction(seedPassages(planEntryId).then((list) => list.passages)),
          (id, offset) =>
            runAction(splitPassage(id, offset.blockEntryId, offset.offset).then((l) => l.passages)),
          (id) => runAction(mergeNextPassage(id).then((list) => list.passages))
        )}
      </div>
      {state.status === "ready" && state.passages.length > 0 ? (
        <div className="mt-8 border-t border-border pt-6">
          <RecitationChainingPanel planEntryId={planEntryId} />
        </div>
      ) : null}
    </PageFrame>
  );
}

type IntroductionState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ introduction: RecitationIntroductionStatusDto; status: "ready" }>;

// The paced new-passage introduction (#607). Introduction is explicit: the learner starts the first
// passage, then introduces the next one at a time — capped per local day, and never while a passage is
// still due. This panel fetches the server-computed status and renders the exact calm state (due work
// remains, cap reached, all introduced) or the primary action ("Start first passage" for the first,
// "New passage" thereafter), enabled only when the server says it is available. Introducing refreshes
// both this status (from the response) and the passage list (via `onIntroduced`).
export function PassageIntroductionPanel({
  onIntroduced,
  planEntryId
}: Readonly<{ onIntroduced: () => void; planEntryId: string }>): React.JSX.Element | null {
  const [state, setState] = useState<IntroductionState>({ status: "loading" });
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    getIntroductionStatus(planEntryId).then(
      (introduction) => setState({ introduction, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, [planEntryId]);

  if (state.status === "loading") {
    return <LoadingIndicator label="Loading introduction…" />;
  }
  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load the introduction. Please try again.
      </p>
    );
  }

  const introduction = state.introduction;
  // A non-learning plan (e.g. maintenance) never introduces new passages, so the invitation is silent.
  if (introduction.reason === "not_learning") {
    return null;
  }

  function introduce(): void {
    setActionFailed(false);
    introduceNextPassage(planEntryId).then(
      (response) => {
        setState({ introduction: response.status, status: "ready" });
        onIntroduced();
      },
      () => setActionFailed(true)
    );
  }

  return (
    <section aria-label="New passage" className="rounded border border-border bg-surface p-4">
      {actionFailed ? (
        <p className="mb-3 text-danger" role="alert">
          Could not introduce the next passage. Please try again.
        </p>
      ) : null}
      {renderIntroductionBody(introduction, introduce)}
    </section>
  );
}

// The calm, reason-specific introduction copy. Due work is always presented before the optional "New
// passage" invitation, and the cap is a resting state ("3 of 3 introduced today"), never a failure.
function renderIntroductionBody(
  introduction: RecitationIntroductionStatusDto,
  introduce: () => void
): React.JSX.Element {
  if (introduction.reason === "due_work_remains") {
    return (
      <p className="text-text-muted">
        You have {introduction.dueCount} passage
        {introduction.dueCount === 1 ? "" : "s"} to practise. Recite{" "}
        {introduction.dueCount === 1 ? "it" : "them"} on Today before introducing a new one.
      </p>
    );
  }
  if (introduction.reason === "cap_reached") {
    return (
      <p className="text-text-muted">
        {introduction.introducedToday} of {introduction.dailyCap} introduced today. Come back
        tomorrow for the next passage.
      </p>
    );
  }
  if (introduction.reason === "all_introduced") {
    return <p className="text-text-muted">Every passage has been introduced.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <Button onClick={introduce} variant="primary">
        {introduction.anyIntroduced ? "New passage" : "Start first passage"}
      </Button>
      <p className="text-text-muted">
        {introduction.anyIntroduced
          ? `${introduction.introducedToday} of ${introduction.dailyCap} introduced today.`
          : "Start reciting your first passage when you are ready."}
      </p>
    </div>
  );
}

function PageFrame({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <section aria-labelledby="recite-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="recite-heading">
        Divide into passages
      </h1>
      <p className="mt-1 text-text-muted">
        Split and merge passages to shape how you recite. The source text never changes.
      </p>
      {children}
    </section>
  );
}

function renderBody(
  state: PassagesState,
  seed: () => void,
  split: (passageEntryId: string, at: Readonly<{ blockEntryId: string; offset: number }>) => void,
  merge: (passageEntryId: string) => void
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Loading passages…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-danger" role="alert">
        Could not load the passages. Please try again.
      </p>
    );
  }

  if (state.passages.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-text-muted">This work has not been divided yet.</p>
        <div>
          <Button onClick={seed} variant="primary">
            Divide into passages
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ol aria-label="Passages" className="flex flex-col gap-4">
      {state.passages.map((passage, index) => (
        <PassageRow
          isLast={index === state.passages.length - 1}
          key={passage.entryId}
          merge={merge}
          passage={passage}
          position={index + 1}
          split={split}
        />
      ))}
    </ol>
  );
}

// One passage: its ordinal, its exact source text, its review progress, and the boundary edits. Split is
// offered only for a single-block passage (the common case after seeding), at a character position inside
// its source; merge joins it with the next passage in reciting order.
function PassageRow({
  isLast,
  merge,
  passage,
  position,
  split
}: Readonly<{
  isLast: boolean;
  merge: (passageEntryId: string) => void;
  passage: RecitationPassageDto;
  position: number;
  split: (passageEntryId: string, at: Readonly<{ blockEntryId: string; offset: number }>) => void;
}>): React.JSX.Element {
  const singleBlock = passage.startBlockEntryId === passage.endBlockEntryId;
  const [offset, setOffset] = useState(1);
  const maxOffset = passage.sourceText.length - 1;

  return (
    <li className="rounded border border-border bg-surface p-4">
      <p className="text-sm text-text-muted">
        Passage {position} · reviewed {passage.reviewCount}{" "}
        {passage.reviewCount === 1 ? "time" : "times"}
      </p>
      <p className="mt-1 text-text">{passage.sourceText}</p>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        {singleBlock && maxOffset >= 1 ? (
          <div className="flex items-end gap-2">
            <label className="flex flex-col text-sm text-text-muted">
              Split at character
              <input
                className="mt-1 w-20 rounded border border-border bg-bg px-2 py-1 text-text"
                max={maxOffset}
                min={1}
                onChange={(event) => setOffset(Number(event.target.value))}
                type="number"
                value={offset}
              />
            </label>
            <Button
              onClick={() =>
                split(passage.entryId, {
                  blockEntryId: passage.startBlockEntryId,
                  offset: passage.startOffset + offset
                })
              }
              size="sm"
              variant="secondary"
            >
              Split
            </Button>
          </div>
        ) : null}
        {isLast ? null : (
          <Button onClick={() => merge(passage.entryId)} size="sm" variant="ghost">
            Merge with next
          </Button>
        )}
      </div>
    </li>
  );
}
