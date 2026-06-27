import { useEffect, useState } from "react";

import type {
  SessionCueDto,
  SessionPlanDto,
  SessionSummaryDto,
  SessionTurnRecord,
  TurnResultDto
} from "@whetstone/contracts";

import { Button } from "../../shared/ui/Button";
import { LoadingIndicator } from "../../shared/ui/LoadingIndicator";
import { endSession, startSession, submitTurn } from "./sessionApi";

// The session is a queue: `cue` is the current cue (always defined), `remaining` the rest. Stepping by
// destructuring keeps the "this was the last cue" branch reachable, so there are no unreachable guards.
type ActiveSession = Readonly<{
  cue: SessionCueDto;
  index: number;
  remaining: ReadonlyArray<SessionCueDto>;
  results: ReadonlyArray<SessionTurnRecord>;
  total: number;
}>;

type SessionState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "error" }>
  | Readonly<{ status: "empty" }>
  | (ActiveSession & Readonly<{ status: "cueing"; submitting: boolean; transcript: string }>)
  | (ActiveSession & Readonly<{ result: TurnResultDto; status: "feedback" }>)
  | Readonly<{ status: "summary"; summary: SessionSummaryDto }>;

function beginSession(plan: SessionPlanDto): SessionState {
  const [first, ...rest] = plan.cues;
  if (first === undefined) {
    return { status: "empty" };
  }
  return {
    cue: first,
    index: 0,
    remaining: rest,
    results: [],
    status: "cueing",
    submitting: false,
    total: plan.cues.length,
    transcript: ""
  };
}

export function SessionPage(): React.JSX.Element {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        setState(beginSession(await startSession()));
      } catch {
        setState({ status: "error" });
      }
    }
    void load();
  }, []);

  async function restart(): Promise<void> {
    setState({ status: "loading" });
    try {
      setState(beginSession(await startSession()));
    } catch {
      setState({ status: "error" });
    }
  }

  async function submit(
    active: ActiveSession & { submitting: boolean; transcript: string }
  ): Promise<void> {
    setState({ ...active, status: "cueing", submitting: true });
    try {
      const result = await submitTurn({
        chunkId: active.cue.chunkId,
        production: { kind: "typed", transcript: active.transcript }
      });
      setState({
        cue: active.cue,
        index: active.index,
        remaining: active.remaining,
        result,
        results: active.results,
        status: "feedback",
        total: active.total
      });
    } catch {
      setState({ status: "error" });
    }
  }

  async function advance(active: ActiveSession & { result: TurnResultDto }): Promise<void> {
    const results: ReadonlyArray<SessionTurnRecord> = [
      ...active.results,
      { errorCategory: active.result.errorCategory, grade: active.result.grade }
    ];

    const [next, ...rest] = active.remaining;
    if (next === undefined) {
      setState({ status: "loading" });
      try {
        setState({ status: "summary", summary: await endSession({ turns: [...results] }) });
      } catch {
        setState({ status: "error" });
      }
      return;
    }

    setState({
      cue: next,
      index: active.index + 1,
      remaining: rest,
      results,
      status: "cueing",
      submitting: false,
      total: active.total,
      transcript: ""
    });
  }

  return (
    <section aria-labelledby="session-heading" className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold text-text" id="session-heading">
        Practice
      </h1>
      <div className="mt-6">{renderState(state, setState, submit, advance, restart)}</div>
    </section>
  );
}

function renderState(
  state: SessionState,
  setState: (next: SessionState) => void,
  submit: (active: ActiveSession & { submitting: boolean; transcript: string }) => Promise<void>,
  advance: (active: ActiveSession & { result: TurnResultDto }) => Promise<void>,
  restart: () => Promise<void>
): React.JSX.Element {
  if (state.status === "loading") {
    return <LoadingIndicator label="Setting up your session…" />;
  }

  if (state.status === "error") {
    return (
      <div role="alert">
        <p className="text-danger">Something went wrong with your session.</p>
        <Button className="mt-3" onClick={() => void restart()}>
          Try again
        </Button>
      </div>
    );
  }

  if (state.status === "empty") {
    return (
      <p className="text-text-muted">
        Nothing to practise right now — every region of your world is lit. Add reading or check back
        later.
      </p>
    );
  }

  if (state.status === "summary") {
    return <SessionSummaryView onRestart={restart} summary={state.summary} />;
  }

  if (state.status === "feedback") {
    return <FeedbackView onNext={() => void advance(state)} state={state} />;
  }

  return <CueView onSubmit={submit} setState={setState} state={state} />;
}

function progressLabel(active: ActiveSession): string {
  return `Cue ${active.index + 1} of ${active.total}`;
}

function CueView({
  onSubmit,
  setState,
  state
}: Readonly<{
  onSubmit: (active: ActiveSession & { submitting: boolean; transcript: string }) => Promise<void>;
  setState: (next: SessionState) => void;
  state: ActiveSession & { status: "cueing"; submitting: boolean; transcript: string };
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">{progressLabel(state)}</p>
      <div className="rounded border border-border bg-surface p-4">
        <p className="text-lg text-text">{state.cue.situation}</p>
        <p className="mt-1 text-sm text-text-muted">{state.cue.communicativeFunction}</p>
        <p className="mt-2 text-xs text-text-muted">
          Say it aloud — aim for ~{state.cue.timerSeconds}s.
        </p>
      </div>

      <label className="text-sm font-medium text-text" htmlFor="session-transcript">
        Then type what you said
      </label>
      <textarea
        className="min-h-24 rounded border border-border bg-surface p-3 text-text"
        id="session-transcript"
        onChange={(event) => setState({ ...state, transcript: event.currentTarget.value })}
        value={state.transcript}
      />
      <Button
        className="self-start"
        onClick={() => void onSubmit(state)}
        pending={state.submitting}
        type="button"
      >
        Submit
      </Button>
    </div>
  );
}

function FeedbackView({
  onNext,
  state
}: Readonly<{
  onNext: () => void;
  state: ActiveSession & { result: TurnResultDto };
}>): React.JSX.Element {
  const isLast = state.remaining.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">{progressLabel(state)}</p>
      <div className="rounded border border-border bg-surface p-4">
        <p className="text-text">
          Grade: <span className="font-semibold">{state.result.grade}/5</span>
        </p>
        <p className="mt-2 text-sm text-text-muted">Native phrasing</p>
        <p className="text-text">{state.result.target}</p>

        <div className="mt-3">
          {state.result.judgement.issues.length === 0 ? (
            <p className="text-sm text-success">That sounded natural.</p>
          ) : (
            <ul aria-label="What was off" className="flex flex-col gap-1 text-sm text-text-muted">
              {state.result.judgement.issues.map((issue) => (
                <li key={issue.note}>{issue.note}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <Button className="self-start" onClick={onNext} type="button">
        {isLast ? "Finish" : "Next"}
      </Button>
    </div>
  );
}

function SessionSummaryView({
  onRestart,
  summary
}: Readonly<{
  onRestart: () => Promise<void>;
  summary: SessionSummaryDto;
}>): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-text">Session complete</h2>
      <ul aria-label="Session summary" className="flex flex-col gap-1 text-text-muted">
        <li>Turns {summary.turnCount}</li>
        <li>Average grade {summary.averageGrade.toFixed(1)}</li>
        <li>Strong turns {summary.strongTurns}</li>
      </ul>
      {summary.errorCounts.length > 0 ? (
        <ul aria-label="Errors to watch" className="flex flex-wrap gap-2">
          {summary.errorCounts.map((error) => (
            <li
              className="rounded border border-border px-2 py-1 text-sm text-text-muted"
              key={error.category}
            >
              {error.category.replace(/_/g, " ")} · {error.count}
            </li>
          ))}
        </ul>
      ) : null}
      <Button className="self-start" onClick={() => void onRestart()} type="button">
        Practise again
      </Button>
    </div>
  );
}
