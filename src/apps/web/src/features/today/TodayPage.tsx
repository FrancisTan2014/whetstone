import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type {
  AuthoredWorkSummaryDto,
  LatestReadingPositionDto,
  NudgeDto,
  RecallItemDto,
  RecitationPlanDto
} from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { fetchContinueWriting } from "../authoredWorks/authoredWorkApi.js";
import { fetchWorks } from "../library/libraryApi.js";
import { dismissNudge, fetchNudge } from "../nudge/nudgeApi.js";
import { fetchDueRecall } from "../recall/recallApi.js";
import {
  fetchContinueRecitation,
  recordRecitationSession,
  setRecitationPhase
} from "../recitation/recitationApi.js";
import { recitationPhaseLabels } from "../recitation/recitationLabels.js";
import { CaptureCard } from "../capture/CaptureCard.js";
import { fetchLatestReadingPosition } from "./todayApi.js";

// Today is a calm, finite, clearable daily board (PRODUCT.md "v0 assistant home (Today)" + "The
// arranger") — never a dashboard, feed, streak, or metric. It COMPOSES already-built slices: the
// voice diary (#246), recall (#318), a Continue-reading seam over the latest reading position, and
// the reading→practice nudge (#245). Each async arm loads independently so one failing never blanks
// the page, and the reader stays calm (none of this lives in it).
//
// On a true cold start — no works, no reading position, no recall due, no nudge — Today would
// otherwise say "done for today", which is untruthful when there is simply nothing to start from. So
// it also reads whether the library holds any work: when every arm is loaded and empty it shows a
// first-run on-ramp ("Start with one source" → Library) and hides the done-for-today line, until the
// learner has at least one work or any trace (#391).

type RecallState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ items: ReadonlyArray<RecallItemDto>; status: "ready" }>;

type ContinueState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ position: LatestReadingPositionDto | undefined; status: "ready" }>;

// The most recently edited unfinished authored Work, powering the "Continue writing" card. An explicit
// server null (nothing authored yet) resolves to `undefined`; a failed load renders a quiet inline note.
type WritingState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; work: AuthoredWorkSummaryDto | undefined }>;

// The learner's most recently touched recitation plan (#577), powering the "Continue recitation" card. An
// explicit server null (no routine adopted) resolves to `undefined`; a failed load renders a quiet note.
type RecitationState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ plan: RecitationPlanDto | undefined; status: "ready" }>;

// The nudge surfaces at most one proposed capture. `nudge: undefined` (cold start / all in cooldown)
// and the loading/error arms all render nothing — the slot simply stays empty, never a placeholder.
type NudgeState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ nudge: NudgeDto | undefined; status: "ready" }>;

// Whether the library holds any work yet. Only its "ready + empty" arm feeds the first-run decision;
// a still-loading or failed load simply means "not known to be a cold start", so Today never claims
// the first-run state on incomplete information.
type LibraryState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ hasWorks: boolean; status: "ready" }>;

export function TodayPage(): React.JSX.Element {
  const [recall, setRecall] = useState<RecallState>({ status: "loading" });
  const [reading, setReading] = useState<ContinueState>({ status: "loading" });
  const [writing, setWriting] = useState<WritingState>({ status: "loading" });
  const [recitation, setRecitation] = useState<RecitationState>({ status: "loading" });
  const [nudge, setNudge] = useState<NudgeState>({ status: "loading" });
  const [library, setLibrary] = useState<LibraryState>({ status: "loading" });

  // Load the due-recall batch on mount. A diary capture journals only (#571) — nothing on Today mutates
  // recall after mount — so this is a plain one-shot load with no in-flight reconciliation. Stable across
  // renders so the effect stays a one-shot, and the resolved arm is set only after the fetch settles (no
  // synchronous setState in the mount effect).
  const loadRecall = useCallback(() => {
    fetchDueRecall().then(
      (items) => setRecall({ items, status: "ready" }),
      () => setRecall({ status: "error" })
    );
  }, []);

  useEffect(() => {
    loadRecall();
    fetchLatestReadingPosition().then(
      (position) => setReading({ position, status: "ready" }),
      () => setReading({ status: "error" })
    );
    fetchContinueWriting().then(
      ({ work }) => setWriting({ status: "ready", work: work ?? undefined }),
      () => setWriting({ status: "error" })
    );
    fetchContinueRecitation().then(
      ({ plan }) => setRecitation({ plan: plan ?? undefined, status: "ready" }),
      () => setRecitation({ status: "error" })
    );
    fetchNudge().then(
      (value) => setNudge({ nudge: value, status: "ready" }),
      () => setNudge({ status: "error" })
    );
    fetchWorks().then(
      (list) => setLibrary({ hasWorks: list.works.length > 0, status: "ready" }),
      () => setLibrary({ status: "error" })
    );
  }, [loadRecall]);

  // Dismiss = cooldown: remove the card at once (a "not now" is honoured immediately) and tell the
  // server in the background. A failed dismiss never blanks Today — the card is already gone.
  function handleDismiss(chunkId: string): void {
    setNudge({ nudge: undefined, status: "ready" });
    void dismissNudge(chunkId).catch(() => undefined);
  }

  // The explicit, learner-driven transition out of familiarization (#577): move the plan to "learning" and
  // reflect it at once. A failed transition leaves the card as it was — Today never blanks on it.
  function handleStartReciting(planEntryId: string): void {
    setRecitationPhase(planEntryId, "learning").then(
      (plan) => setRecitation({ plan, status: "ready" }),
      () => undefined
    );
  }

  // Opening a recitation session records lightweight routine state (session count + time) in the
  // background; the reader deep-link (the anchor's href) resumes the saved position. Best-effort — a failed
  // record never blocks opening the reader.
  function handleRecitationSession(planEntryId: string): void {
    void recordRecitationSession(planEntryId).catch(() => undefined);
  }

  const firstRun = isFirstRun({ library, nudge, reading, recall });

  return (
    <section aria-labelledby="today-heading" className="mx-auto max-w-2xl p-6">
      <header>
        <h1 className="text-2xl font-semibold text-text" id="today-heading">
          Today
        </h1>
        <p className="mt-1 text-text-muted">
          A small, finishable set. Clear it, then rest and play freely.
        </p>
      </header>

      <div className="mt-6 flex flex-col gap-4">
        {firstRun ? <FirstRunCard /> : null}
        <CaptureCard />
        <RecallCard state={recall} />
        <ContinueReadingCard state={reading} />
        <ContinueWritingCard state={writing} />
        <ContinueRecitationCard
          onContinue={handleRecitationSession}
          onStartReciting={handleStartReciting}
          state={recitation}
        />
        <NudgeCard state={nudge} onDismiss={handleDismiss} />
        <ClearedState library={library} reading={reading} recall={recall} nudge={nudge} />
      </div>
    </section>
  );
}

// A truthful cold start: every actionable arm is loaded AND empty and the library holds no work.
// Any arm still loading or failed makes this false, so Today shows the normal board rather than
// claiming a first-run state it cannot confirm (#391).
function isFirstRun({
  library,
  nudge,
  reading,
  recall
}: Readonly<{
  library: LibraryState;
  nudge: NudgeState;
  reading: ContinueState;
  recall: RecallState;
}>): boolean {
  return (
    library.status === "ready" &&
    !library.hasWorks &&
    reading.status === "ready" &&
    reading.position === undefined &&
    recall.status === "ready" &&
    recall.items.length === 0 &&
    nudge.status === "ready" &&
    nudge.nudge === undefined
  );
}

// The first-run on-ramp: shown only on a confirmed cold start. It points at the single next step —
// add or import one work — and routes to Library (never duplicating Library's add/upload forms).
function FirstRunCard(): React.JSX.Element {
  return (
    <section
      aria-label="Start with one source"
      className="rounded border border-border bg-surface p-4"
    >
      <h2 className="text-lg font-medium text-text">Start with one source</h2>
      <p className="mt-1 text-text-muted">Add or import a reading — one work is enough to begin.</p>
      <Link className={`${buttonVariants({ variant: "primary" })} mt-3`} to="/library">
        Open Library
      </Link>
    </section>
  );
}

// Recall proposals: today's due batch (already capped server-side). Restraint — at most ONE item is
// shown here at a glance, with a Review link to the full Recall surface for the rest. Zero due is a
// quiet, explicit empty line; a load failure is a quiet inline note, never a page-blanking error.
function RecallCard({ state }: Readonly<{ state: RecallState }>): React.JSX.Element {
  return (
    <section aria-label="Recall" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Recall</h2>
      <div className="mt-2">{renderRecall(state)}</div>
    </section>
  );
}

function renderRecall(state: RecallState): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Gathering what's due…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-text-muted" role="alert">
        Couldn&rsquo;t load recall right now.
      </p>
    );
  }

  const [first] = state.items;

  if (first === undefined) {
    return <p className="text-text-muted">Nothing due — you&rsquo;re caught up.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-text">
        Recall {state.items.length === 1 ? "this 1 item" : `these ${state.items.length} items`}.
      </p>
      <div>
        <p className="text-lg text-text">{first.text}</p>
        {first.gloss === null ? null : (
          <p className="mt-1 text-sm text-text-muted">{first.gloss}</p>
        )}
      </div>
      <Link className={buttonVariants({ variant: "secondary" })} to="/recall">
        Review
      </Link>
    </div>
  );
}

// Continue reading composes the cross-work latest reading position. Present -> a deep link straight
// back into the reader (`#/reader?work=…`, the same convention Search uses). None -> a quiet line; a
// failure -> a quiet inline note. The reader stays calm — opening it here changes nothing about it.
function ContinueReadingCard({ state }: Readonly<{ state: ContinueState }>): React.JSX.Element {
  return (
    <section aria-label="Continue reading" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Continue reading</h2>
      <div className="mt-2">{renderReading(state)}</div>
    </section>
  );
}

function renderReading(state: ContinueState): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Finding where you left off…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-text-muted" role="alert">
        Couldn&rsquo;t load your reading right now.
      </p>
    );
  }

  if (state.position === undefined) {
    return <p className="text-text-muted">Nothing to continue yet.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-text">{state.position.workTitle}</p>
      <a
        className={buttonVariants({ variant: "secondary" })}
        href={`#/reader?work=${encodeURIComponent(state.position.workEntryId)}`}
      >
        Continue
      </a>
    </div>
  );
}

// Continue writing composes the most recently edited unfinished authored Work (#576). Present -> a deep
// link straight into the immersive editor (`#/write?work=…`). None -> a quiet line; a failure -> a quiet
// inline note. Like the other arms it loads independently, so a failure here never blanks Today.
function ContinueWritingCard({ state }: Readonly<{ state: WritingState }>): React.JSX.Element {
  return (
    <section aria-label="Continue writing" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Continue writing</h2>
      <div className="mt-2">{renderWriting(state)}</div>
    </section>
  );
}

function renderWriting(state: WritingState): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Finding your latest draft…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-text-muted" role="alert">
        Couldn&rsquo;t load your writing right now.
      </p>
    );
  }

  if (state.work === undefined) {
    return <p className="text-text-muted">No drafts yet — start one from your Library.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-text">{state.work.title}</p>
      <a
        className={buttonVariants({ variant: "secondary" })}
        href={`#/write?work=${encodeURIComponent(state.work.entryId)}`}
      >
        Continue
      </a>
    </div>
  );
}

// Continue recitation composes the learner's most recently touched recitation plan (#577). Present -> the
// Work title, its current phase, a Continue that resumes the saved reading position (`#/reader?work=…`,
// recording a lightweight session), and — only while familiarizing — an explicit "Start reciting" that
// moves into active recitation. None -> a quiet line; a failure -> a quiet inline note. There is NO
// streak, timer, backlog, or warning: a missed day costs nothing (the arranger's compassion clause).
function ContinueRecitationCard({
  onContinue,
  onStartReciting,
  state
}: Readonly<{
  onContinue: (planEntryId: string) => void;
  onStartReciting: (planEntryId: string) => void;
  state: RecitationState;
}>): React.JSX.Element {
  return (
    <section aria-label="Continue recitation" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Continue recitation</h2>
      <div className="mt-2">{renderRecitation(state, onContinue, onStartReciting)}</div>
    </section>
  );
}

function renderRecitation(
  state: RecitationState,
  onContinue: (planEntryId: string) => void,
  onStartReciting: (planEntryId: string) => void
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Finding your recitation routine…" />;
  }

  if (state.status === "error") {
    return (
      <p className="text-text-muted" role="alert">
        Couldn&rsquo;t load your recitation right now.
      </p>
    );
  }

  if (state.plan === undefined) {
    return (
      <p className="text-text-muted">
        No recitation routine yet — adopt one from your Library.
      </p>
    );
  }

  const plan = state.plan;
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="text-text">{plan.workTitle}</p>
        <p className="text-sm text-text-muted">{recitationPhaseLabels[plan.phase]}</p>
      </div>
      <div className="flex flex-wrap gap-3">
        <a
          className={buttonVariants({ variant: "secondary" })}
          href={`#/reader?work=${encodeURIComponent(plan.workEntryId)}`}
          onClick={() => onContinue(plan.entryId)}
        >
          Continue
        </a>
        {plan.phase === "familiarizing" ? (
          <button
            className={buttonVariants({ variant: "primary" })}
            onClick={() => onStartReciting(plan.entryId)}
            type="button"
          >
            Start reciting
          </button>
        ) : null}
      </div>
    </div>
  );
}

// The reading→practice nudge (#245): a quiet, dismissible card proposing the single highest-value,
// non-cooled-down recent reading capture to practise. Present -> a one-line invitation plus an accept
// that opens Practice (where the session leads with this same proposed case) and a dismiss (✕) that
// puts it in cooldown. Absent / loading / failed -> the slot renders nothing (no placeholder); a
// nudge failure never blanks Today. One at a time, never spammy, never in the reader.
const SNIPPET_MAX_CHARS = 80;

function shortSnippet(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= SNIPPET_MAX_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…`;
}

function activeNudge(state: NudgeState): NudgeDto | undefined {
  return state.status === "ready" ? state.nudge : undefined;
}

function NudgeCard({
  onDismiss,
  state
}: Readonly<{
  onDismiss: (chunkId: string) => void;
  state: NudgeState;
}>): React.JSX.Element | null {
  const nudge = activeNudge(state);
  if (nudge === undefined) {
    return null;
  }

  return (
    <section aria-label="Practice nudge" className="rounded border border-border bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-medium text-text">Practice</h2>
        <button
          aria-label="Dismiss this practice nudge"
          className="inline-flex min-h-11 min-w-11 items-center justify-center text-text-muted hover:text-text"
          onClick={() => onDismiss(nudge.chunkId)}
          type="button"
        >
          ✕
        </button>
      </div>
      <p className="mt-1 text-text">
        Practise <em>{shortSnippet(nudge.text)}</em> from <em>{nudge.workTitle}</em>.
      </p>
      <Link className={`${buttonVariants({ variant: "primary" })} mt-3`} to="/practice">
        Practise now
      </Link>
    </section>
  );
}

// The arranger's compassion clause (PRODUCT.md "The arranger"): when the actionable arms are cleared
// (no recall due AND no practice nudge to act on), Today shows a calm "done for today" that frees the
// user — NO streak, NO guilt, NO back-judge, NO penalty. A low or empty day is fine. Diary capture and
// Continue reading may still show — they are invitations.
//
// "Done for today" is itself a state claim, so it may only appear once Today has positively ruled out
// a cold start: a loaded non-empty library OR a loaded reading position. While the library (or every
// arm) is still loading or has failed, neither this line nor the first-run card is shown — Today makes
// no state claim on unknown information (#391).
function ClearedState({
  library,
  nudge,
  reading,
  recall
}: Readonly<{
  library: LibraryState;
  nudge: NudgeState;
  reading: ContinueState;
  recall: RecallState;
}>): React.JSX.Element | null {
  const actionableClear =
    recall.status === "ready" &&
    recall.items.length === 0 &&
    nudge.status === "ready" &&
    nudge.nudge === undefined;
  const ruledOutColdStart =
    (library.status === "ready" && library.hasWorks) ||
    (reading.status === "ready" && reading.position !== undefined);

  if (!actionableClear || !ruledOutColdStart) {
    return null;
  }

  return (
    <p className="rounded border border-border bg-surface p-4 text-text-muted">
      You&rsquo;re done for today. Rest and play freely.
    </p>
  );
}
