import { useEffect, useState } from "react";

import type { RecitationPassageDto } from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { listPassages, mergeNextPassage, seedPassages, splitPassage } from "./recitationPassageApi";

type PassagesState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ passages: ReadonlyArray<RecitationPassageDto>; status: "ready" }>;

// The passage segmentation + progress surface for one recitation plan (#578). A learner divides the
// plan's Work into contiguous passages (seed), then edits the boundaries — split a passage at a character
// position, or merge one with the next — without ever changing the canonical Work text. Each passage's
// review progress is shown here (the plan's practice history); the actual due practice happens on Today.
// Boundary edits reset that passage's schedule, so this is a Learning-phase setup activity, kept calm and
// off the reader.
export function RecitePage({
  planEntryId
}: Readonly<{ planEntryId?: string | undefined }>): React.JSX.Element {
  const [state, setState] = useState<PassagesState>(
    planEntryId === undefined ? { passages: [], status: "ready" } : { status: "loading" }
  );
  const [actionFailed, setActionFailed] = useState(false);

  useEffect(() => {
    if (planEntryId === undefined) {
      return;
    }
    listPassages(planEntryId).then(
      (list) => setState({ passages: list.passages, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, [planEntryId]);

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
      <div className="mt-6">
        {renderBody(
          state,
          () => runAction(seedPassages(planEntryId).then((list) => list.passages)),
          (id, offset) =>
            runAction(splitPassage(id, offset.blockEntryId, offset.offset).then((l) => l.passages)),
          (id) => runAction(mergeNextPassage(id).then((list) => list.passages))
        )}
      </div>
    </PageFrame>
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
