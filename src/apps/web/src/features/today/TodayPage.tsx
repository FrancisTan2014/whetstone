import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { TodayBoardDto, TodayRoutineDto, TodayRoutineKind } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { PageFrame } from "../../shared/ui/PageFrame";
import { fetchTodayBoard } from "./todayApi";
import { TodayCapture } from "./TodayCapture";
import { todayRoutineActionLabels, todayRoutinePaths, todayRoutineTitles } from "./today.tokens";

// Today is the deterministic routine board (#610): one calm, finishable, vertical column composed
// entirely server-side for the learner's local day (#606). It shows only true obligations — each due
// routine (#609 Recitation, Memory review) as ONE grouped row, ordered overdue-first — plus visibly
// secondary Continue invitations that never block the clear state, and the always-present save-first
// quick capture. It infers nothing, ranks nothing, and never shows a false "all clear": a routine that
// failed to load keeps the board un-clear. There is NO dashboard, feed, streak, score, or nudge.
//
// The whole board is one fetch; every deep link routes into the owning feature and returns to a freshly
// recomputed board, so Today also refetches whenever the tab regains focus.

// The quiet, visibly-secondary Continue links stay light (a small underlined link) but still meet the
// ≥44px WCAG 2.5.5 hit target (#519) via an inline-flex box with a 44px min height and width.
const quietLinkClass =
  "inline-flex min-h-[44px] min-w-[44px] items-center text-sm text-text underline";

type BoardState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ board: TodayBoardDto; status: "ready" }>;

export function TodayPage(): React.JSX.Element {
  const [state, setState] = useState<BoardState>({ status: "loading" });

  // One board load, reused by the mount effect, the focus refetch, and every Retry. State is set only
  // after the fetch settles (never synchronously inside the effect), so the initial `loading` state
  // covers the first paint and a refetch swaps the board in place without a flash.
  const load = useCallback(() => {
    fetchTodayBoard().then(
      (board) => setState({ board, status: "ready" }),
      () => setState({ status: "error" })
    );
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Returning from a deep-linked feature (recitation, recall, reader, writing, diary) must show a freshly
  // recomputed board, so recompute whenever the tab regains focus rather than trusting the stale snapshot.
  useEffect(() => {
    const handleFocus = (): void => load();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [load]);

  return (
    <PageFrame title="Today">
      {renderPrimary(state, load)}
      {/* Quick capture is save-first and always available — even while the board loads or fails —
          and never marks other work done or schedules review. */}
      <TodayCapture />
      {state.status === "ready" ? <ContinueSection board={state.board} reload={load} /> : null}
    </PageFrame>
  );
}

function renderPrimary(state: BoardState, reload: () => void): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Loading your day…" />;
  }
  if (state.status === "error") {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <p className="text-text-muted">
          Couldn&rsquo;t load your day right now. Check your connection and try again.
        </p>
        <div>
          <button
            className={buttonVariants({ variant: "secondary" })}
            onClick={reload}
            type="button"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
  return <PrimaryBoard board={state.board} reload={reload} />;
}

// A confirmed first run: nothing is due, no routine failed, and there is not a single thing to continue.
// Only then does Today replace the caught-up line with an on-ramp, so it never claims "first run" while
// the learner in fact has work in progress.
function isFirstRun(board: TodayBoardDto): boolean {
  return (
    board.clear &&
    board.continueReading.status === "empty" &&
    board.continueWriting.status === "empty"
  );
}

// The primary obligations region: the Due-now routines, any routine-failure notes, and either the
// first-run on-ramp or the truthful clear line. Quick capture and the Continue section render outside it.
function PrimaryBoard({
  board,
  reload
}: Readonly<{ board: TodayBoardDto; reload: () => void }>): React.JSX.Element {
  const firstRun = isFirstRun(board);
  return (
    <div className="flex flex-col gap-6">
      {board.dueNow.length > 0 ? (
        <section aria-labelledby="today-due-heading" className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-text" id="today-due-heading">
            Due now
          </h2>
          <ul className="flex flex-col gap-3">
            {board.dueNow.map((routine) => (
              <DueRoutineRow key={routine.kind} routine={routine} />
            ))}
          </ul>
        </section>
      ) : null}

      {board.routineFailures.map((kind) => (
        <RoutineFailureNote key={kind} kind={kind} reload={reload} />
      ))}

      {firstRun ? (
        <FirstRunOnRamp />
      ) : board.clear ? (
        <DoneForToday nextReviewAt={board.nextReviewAt} />
      ) : null}
    </div>
  );
}

// Render the next scheduled review instant as a calm absolute date in UTC, so the caption stays stable
// regardless of the runner's local timezone. Learner-facing, e.g. "July 5, 2026".
function formatNextReview(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric"
  });
}

// The truthful completion state (#639): shown only when every required source loaded and nothing is
// due. It reports the next known due time beneath it when one exists, and omits it entirely when nothing
// is enrolled ahead rather than inventing a date. No streak, score, or "rest and play" prescription.
function DoneForToday({
  nextReviewAt
}: Readonly<{ nextReviewAt: string | null }>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1" role="status">
      <p className="text-text">Done for today.</p>
      {nextReviewAt === null ? null : (
        <p className="text-sm text-text-muted">Next review {formatNextReview(nextReviewAt)}.</p>
      )}
    </div>
  );
}

// One grouped Due-now row: the routine title, a single count (with overdue emphasis when any are
// overdue), and one deep link into the owning feature. Never one row per prompt or passage.
function DueRoutineRow({ routine }: Readonly<{ routine: TodayRoutineDto }>): React.JSX.Element {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded border border-border bg-surface p-4">
      <div>
        <p className="font-medium text-text">{todayRoutineTitles[routine.kind]}</p>
        <p
          className={routine.overdue ? "text-sm font-medium text-text" : "text-sm text-text-muted"}
        >
          {routine.dueCount} due
          {routine.overdue ? ` · ${routine.overdueCount} overdue` : ""}
        </p>
      </div>
      <Link className={buttonVariants({ variant: "primary" })} to={todayRoutinePaths[routine.kind]}>
        {todayRoutineActionLabels[routine.kind]}
      </Link>
    </li>
  );
}

// A routine source that failed to load: a quiet, un-clearing note with a Retry that recomputes the whole
// board, so a transient failure never reads as "all clear".
function RoutineFailureNote({
  kind,
  reload
}: Readonly<{ kind: TodayRoutineKind; reload: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" role="alert">
      <p className="text-text-muted">
        Couldn&rsquo;t load your {todayRoutineTitles[kind].toLowerCase()} right now.
      </p>
      <button
        className={buttonVariants({ size: "sm", variant: "secondary" })}
        onClick={reload}
        type="button"
      >
        Retry
      </button>
    </div>
  );
}

// The first-run on-ramp: shown only on a confirmed cold start. It names the single next step — add one
// source — and routes to the Library rather than duplicating its forms.
function FirstRunOnRamp(): React.JSX.Element {
  return (
    <section
      aria-label="Get started"
      className="flex flex-col gap-2 rounded border border-border bg-surface p-4"
    >
      <p className="text-text">Start with one source to read, recite, or remember.</p>
      <div>
        <Link className={buttonVariants({ variant: "primary" })} to="/library">
          Go to your Library
        </Link>
      </div>
    </section>
  );
}

// The visibly-secondary Continue section (#639): optional invitations that never block completion. It
// renders only when reading or writing has a real resumable item — or a quiet retry after a failed load
// — and hides entirely (heading included) when neither exists. Empty placeholders never appear, and the
// permanent diary-return link is gone now Diary is a primary destination (#638).
function ContinueSection({
  board,
  reload
}: Readonly<{ board: TodayBoardDto; reload: () => void }>): React.JSX.Element | null {
  const { continueReading, continueWriting } = board;
  if (continueReading.status === "empty" && continueWriting.status === "empty") {
    return null;
  }
  return (
    <section aria-labelledby="today-continue-heading" className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-text-muted" id="today-continue-heading">
        Continue
      </h2>
      {continueReading.status === "empty" ? null : (
        <ContinueReading reading={continueReading} reload={reload} />
      )}
      {continueWriting.status === "empty" ? null : (
        <ContinueWriting writing={continueWriting} reload={reload} />
      )}
    </section>
  );
}

// A resumable reading/writing invitation: the ready link or a failed load's quiet retry. The empty
// variant is excluded upstream (`ContinueSection` renders these only for a non-empty source), so it is
// never a state here.
type ReadingInvitation = Exclude<TodayBoardDto["continueReading"], { status: "empty" }>;
type WritingInvitation = Exclude<TodayBoardDto["continueWriting"], { status: "empty" }>;

function ContinueReading({
  reading,
  reload
}: Readonly<{ reading: ReadingInvitation; reload: () => void }>): React.JSX.Element {
  if (reading.status === "failed") {
    return <FailedInvitation label="reading" reload={reload} />;
  }
  return (
    <Link
      className={quietLinkClass}
      to={`/reader?work=${encodeURIComponent(reading.position.workEntryId)}`}
    >
      Keep reading {reading.position.workTitle}
    </Link>
  );
}

function ContinueWriting({
  writing,
  reload
}: Readonly<{ writing: WritingInvitation; reload: () => void }>): React.JSX.Element {
  if (writing.status === "failed") {
    return <FailedInvitation label="writing" reload={reload} />;
  }
  return (
    <Link className={quietLinkClass} to={`/write?work=${encodeURIComponent(writing.work.entryId)}`}>
      Keep writing {writing.work.title}
    </Link>
  );
}

// A failed invitation load: a quiet retry that never blocks the clear state or shouts for attention.
function FailedInvitation({
  label,
  reload
}: Readonly<{ label: string; reload: () => void }>): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2" role="alert">
      <p className="text-sm text-text-muted">Couldn&rsquo;t load your {label} right now.</p>
      <button className={quietLinkClass} onClick={reload} type="button">
        Retry
      </button>
    </div>
  );
}
