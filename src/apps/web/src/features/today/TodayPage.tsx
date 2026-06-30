import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { LatestReadingPositionDto, NudgeDto, RecallItemDto } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { dismissNudge, fetchNudge } from "../nudge/nudgeApi.js";
import { fetchDueRecall } from "../recall/recallApi.js";
import { fetchLatestReadingPosition } from "./todayApi.js";

// Today is a calm, finite, clearable daily board (PRODUCT.md "v0 assistant home (Today)" + "The
// arranger") — never a dashboard, feed, streak, or metric. It COMPOSES already-built slices: the
// voice diary (#246), recall (#318), a Continue-reading seam over the latest reading position, and
// the reading→practice nudge (#245). Each async arm loads independently so one failing never blanks
// the page, and the reader stays calm (none of this lives in it).

type RecallState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ items: ReadonlyArray<RecallItemDto>; status: "ready" }>;

type ContinueState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ position: LatestReadingPositionDto | undefined; status: "ready" }>;

// The nudge surfaces at most one proposed capture. `nudge: undefined` (cold start / all in cooldown)
// and the loading/error arms all render nothing — the slot simply stays empty, never a placeholder.
type NudgeState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ nudge: NudgeDto | undefined; status: "ready" }>;

export function TodayPage(): React.JSX.Element {
  const [recall, setRecall] = useState<RecallState>({ status: "loading" });
  const [reading, setReading] = useState<ContinueState>({ status: "loading" });
  const [nudge, setNudge] = useState<NudgeState>({ status: "loading" });

  useEffect(() => {
    fetchDueRecall().then(
      (items) => setRecall({ items, status: "ready" }),
      () => setRecall({ status: "error" })
    );
    fetchLatestReadingPosition().then(
      (position) => setReading({ position, status: "ready" }),
      () => setReading({ status: "error" })
    );
    fetchNudge().then(
      (value) => setNudge({ nudge: value, status: "ready" }),
      () => setNudge({ status: "error" })
    );
  }, []);

  // Dismiss = cooldown: remove the card at once (a "not now" is honoured immediately) and tell the
  // server in the background. A failed dismiss never blanks Today — the card is already gone.
  function handleDismiss(chunkId: string): void {
    setNudge({ nudge: undefined, status: "ready" });
    void dismissNudge(chunkId).catch(() => undefined);
  }

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
        <DiaryCaptureCard />
        <RecallCard state={recall} />
        <ContinueReadingCard state={reading} />
        <NudgeCard state={nudge} onDismiss={handleDismiss} />
        <ClearedState recall={recall} nudge={nudge} />
      </div>
    </section>
  );
}

// Capture is an invitation, not a task, so the quick-capture card is always present. The full
// tap-and-talk capture lives in the Diary (#246); Today only links there — it never duplicates it.
function DiaryCaptureCard(): React.JSX.Element {
  return (
    <section aria-label="Capture a thought" className="rounded border border-border bg-surface p-4">
      <h2 className="text-lg font-medium text-text">Capture a thought</h2>
      <p className="mt-1 text-text-muted">
        Tap and talk — say what&rsquo;s on your mind and it lands in your diary.
      </p>
      <Link className={`${buttonVariants({ variant: "primary" })} mt-3`} to="/diary">
        Open your diary
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
          className="text-text-muted hover:text-text"
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
function ClearedState({
  nudge,
  recall
}: Readonly<{ nudge: NudgeState; recall: RecallState }>): React.JSX.Element | null {
  const recallCleared = recall.status === "ready" && recall.items.length === 0;
  if (!recallCleared || activeNudge(nudge) !== undefined) {
    return null;
  }

  return (
    <p className="rounded border border-border bg-surface p-4 text-text-muted">
      You&rsquo;re done for today. Rest and play freely.
    </p>
  );
}
