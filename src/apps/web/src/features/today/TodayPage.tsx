import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import type { LatestReadingPositionDto, RecallItemDto } from "@whetstone/contracts";

import { buttonVariants } from "../../shared/ui/Button.js";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator.js";
import { fetchDueRecall } from "../recall/recallApi.js";
import { fetchLatestReadingPosition } from "./todayApi.js";

// Today is a calm, finite, clearable daily board (PRODUCT.md "v0 assistant home (Today)" + "The
// arranger") — never a dashboard, feed, streak, or metric. It COMPOSES already-built slices: the
// voice diary (#246), recall (#318), and a Continue-reading seam over the latest reading position.
// Each async arm loads independently so one failing never blanks the page, and the reader stays calm
// (none of this lives in it).

type RecallState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ items: ReadonlyArray<RecallItemDto>; status: "ready" }>;

type ContinueState =
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "loading" }>
  | Readonly<{ position: LatestReadingPositionDto | undefined; status: "ready" }>;

export function TodayPage(): React.JSX.Element {
  const [recall, setRecall] = useState<RecallState>({ status: "loading" });
  const [reading, setReading] = useState<ContinueState>({ status: "loading" });

  useEffect(() => {
    fetchDueRecall().then(
      (items) => setRecall({ items, status: "ready" }),
      () => setRecall({ status: "error" })
    );
    fetchLatestReadingPosition().then(
      (position) => setReading({ position, status: "ready" }),
      () => setReading({ status: "error" })
    );
  }, []);

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
        {/*
          Practice-nudge slot (#245 — the reading→practice nudge — is not built yet, so this renders
          NOTHING: no empty placeholder). When #245 ships, drop its Today card here, between Continue
          reading and the cleared state, so it joins the actionable arms the cleared state reads.
        */}
        <ClearedState recall={recall} />
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

// The arranger's compassion clause (PRODUCT.md "The arranger"): when the actionable arms are cleared
// (no recall due; the practice nudge is not built, so it is always clear), Today shows a calm
// "done for today" that frees the user — NO streak, NO guilt, NO back-judge, NO penalty. A low or
// empty day is fine. Diary capture and Continue reading may still show — they are invitations.
function ClearedState({ recall }: Readonly<{ recall: RecallState }>): React.JSX.Element | null {
  if (recall.status !== "ready" || recall.items.length > 0) {
    return null;
  }

  return (
    <p className="rounded border border-border bg-surface p-4 text-text-muted">
      You&rsquo;re done for today. Rest and play freely.
    </p>
  );
}
