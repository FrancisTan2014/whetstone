import type { ExplainUnavailableReason } from "@whetstone/contracts";

import { isAgentError } from "../../agent/agentFailure.js";
import type {
  Agent,
  AgentSession,
  AgentSessionConfig,
  AgentTurn
} from "../../agent/agentSession.js";

// The consumer-owned request deadline for one explanation turn (#924). The warm Copilot runtime
// (`copilotSdkAgent.ts`, #923) already owns a robust internal turn deadline, but that only bounds
// `session.send()` — never the `agent.open()` call that precedes it, nor the `session.close()` that
// follows a successful send. This seam bounds the WHOLE request (session setup AND cleanup included)
// under ONE shared deadline: a session that finishes opening only AFTER this deadline has already
// fired is closed but NEVER handed a prompt, and a close() that hangs long enough to exhaust the same
// deadline no longer blocks the caller indefinitely — the caller is told "timeout" while the close's
// real eventual outcome is still recorded via the diagnostic log in the background.
//
// `session.close()` is called AT MOST ONCE per session, memoized behind `createSessionCloser` below, so
// neither the deadline race nor any later background logging can ever call it twice.

export type ExplainTurnScheduler = Readonly<{
  schedule(callback: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}>;

const defaultScheduler: ExplainTurnScheduler = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, ms) => setTimeout(callback, ms)
};

export type ExplainTurnFailureCode = ExplainUnavailableReason;

export type ExplainTurnOutcome =
  | Readonly<{ kind: "ok"; turn: AgentTurn }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "failed"; code: ExplainTurnFailureCode }>;

// Structured, content-free cleanup diagnostics (never prompt/answer/selected-text — only event/status/
// duration, mirroring `copilotSdkAgent.ts`'s `CopilotSdkLogRecord` convention). Emitted for every
// `session.close()` outcome, INCLUDING one that settles only after this module has already returned
// "timeout" to its caller — the diagnostic still fires from inside the memoized close promise itself,
// not from any code path the caller is still awaiting.
export type ExplainTurnLogRecord = Readonly<{
  durationMs: number;
  event: "session_open" | "session_close";
  status: "ok" | "timeout" | ExplainTurnFailureCode;
}>;

export type ExplainTurnLogger = (record: ExplainTurnLogRecord) => void;

export type RunExplainTurnDependencies = Readonly<{
  agent: Agent;
  log?: ExplainTurnLogger;
  now?: () => number;
  prompt: string;
  scheduler?: ExplainTurnScheduler;
  sessionConfig: AgentSessionConfig;
  timeoutMs: number;
}>;

function mapFailureCode(error: unknown): ExplainTurnFailureCode {
  if (isAgentError(error)) {
    if (error.code === "agent_startup_failed") {
      return "startup_failed";
    }
    if (error.code === "agent_unsupported_model") {
      return "unsupported_model";
    }
  }
  // Every other agent-seam failure (transport failure, a closed-session error that should never occur
  // given this module's own lifecycle) is reported as the generic "the runtime itself failed" reason —
  // never the raw message. `agent_timeout` is intercepted before this function is ever reached
  // (`classifyAgentFailure`), so it can never fall through to this generic bucket.
  return "transport_failed";
}

type AgentFailureClassification =
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "failed"; code: ExplainTurnFailureCode }>;

// The warm Copilot runtime's own internal turn deadline (120s, `copilotSdkAgent.ts`) is routinely
// SHORTER than this consumer's owned deadline (150s), so a real `AgentError("agent_timeout", ...)` is
// an expected, common outcome in production — it must map to the dedicated `timeout` outcome, never the
// generic `transport_failed` reason, wherever an agent-seam failure is classified (open, send, or close).
function classifyAgentFailure(error: unknown): AgentFailureClassification {
  if (isAgentError(error) && error.code === "agent_timeout") {
    return { kind: "timeout" };
  }
  return { code: mapFailureCode(error), kind: "failed" };
}

type CloseOutcome =
  | Readonly<{ kind: "ok" }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "failed"; code: ExplainTurnFailureCode }>;

// `session.close()` is invoked at most once: the returned function memoizes the SAME promise across
// every caller (the deadline race, a background continuation after the deadline already won, or both),
// so a slow close can never be started twice by two different code paths racing it. Its outcome
// (success or failure) is always logged from inside this promise's own settlement — regardless of
// whether the code that eventually called this function is still around to observe the return value.
// Exported so this documented at-most-once invariant has a direct test — `runExplainTurn`'s own control
// flow only ever calls the closer it creates from exactly one branch per request, so the memoization
// guard cannot be exercised twice through that single public entry point alone.
export function createSessionCloser(
  session: AgentSession,
  log: ExplainTurnLogger,
  now: () => number
): () => Promise<CloseOutcome> {
  let closePromise: Promise<CloseOutcome> | undefined;
  return function closeSessionOnce(): Promise<CloseOutcome> {
    if (closePromise === undefined) {
      const startedAt = now();
      closePromise = session.close().then(
        (): CloseOutcome => {
          log({ durationMs: now() - startedAt, event: "session_close", status: "ok" });
          return { kind: "ok" };
        },
        (error: unknown): CloseOutcome => {
          const classified = classifyAgentFailure(error);
          log({
            durationMs: now() - startedAt,
            event: "session_close",
            status: classified.kind === "timeout" ? "timeout" : classified.code
          });
          return classified;
        }
      );
    }
    return closePromise;
  };
}

// Run exactly one turn under one owned deadline covering `agent.open()`, `session.send()`, AND the
// final `session.close()` together.
export async function runExplainTurn(
  dependencies: RunExplainTurnDependencies
): Promise<ExplainTurnOutcome> {
  const scheduler = dependencies.scheduler ?? defaultScheduler;
  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? (() => {});
  const requestStartedAt = now();

  let timeoutHandle: unknown;
  const deadline = new Promise<Readonly<{ kind: "timeout" }>>((resolve) => {
    timeoutHandle = scheduler.schedule(() => resolve({ kind: "timeout" }), dependencies.timeoutMs);
  });

  function clearDeadline(): void {
    scheduler.cancel(timeoutHandle);
  }

  const sessionPromise = dependencies.agent.open(dependencies.sessionConfig);
  const openOutcome = await Promise.race([
    sessionPromise.then(
      (session) => ({ kind: "opened", session }) as const,
      (error: unknown) => ({ kind: "open_failed", error }) as const
    ),
    deadline
  ]);

  if (openOutcome.kind === "timeout") {
    // The deadline won the race. Whatever this open() eventually resolves to must be closed, never
    // sent a prompt — the caller has already moved on. Nothing further is bounded here: this cleanup
    // happens entirely in the background, and its real outcome (or the fact that open() itself later
    // failed too, in which case there is no session to close at all) is still recorded via the
    // diagnostic log.
    void sessionPromise.then(
      (session) => {
        void createSessionCloser(session, log, now)();
      },
      (error: unknown) => {
        const classified = classifyAgentFailure(error);
        log({
          durationMs: now() - requestStartedAt,
          event: "session_open",
          status: classified.kind === "timeout" ? "timeout" : classified.code
        });
      }
    );
    return { kind: "timeout" };
  }

  if (openOutcome.kind === "open_failed") {
    clearDeadline();
    return classifyAgentFailure(openOutcome.error);
  }

  const { session } = openOutcome;
  const closeSession = createSessionCloser(session, log, now);

  const sendOutcome = await Promise.race([
    session.send(dependencies.prompt).then(
      (turn) => ({ kind: "ok", turn }) as const,
      (error: unknown) => ({ kind: "send_failed", error }) as const
    ),
    deadline
  ]);

  if (sendOutcome.kind === "timeout") {
    // Bound cleanup no further than logging its eventual outcome in the background: the caller has
    // already moved on with "timeout", and awaiting an unbounded close() here would only delay the
    // response with no benefit to the caller.
    void closeSession();
    return { kind: "timeout" };
  }

  if (sendOutcome.kind === "send_failed") {
    clearDeadline();
    // The ORIGINAL send failure is the outcome the caller gets, even if this close() also fails — a
    // cleanup failure is only ever logged here, never allowed to override an already-determined
    // primary failure.
    void closeSession();
    return classifyAgentFailure(sendOutcome.error);
  }

  // The send succeeded. The final close() is still bounded by THIS SAME overall deadline (never
  // cleared before it, and never awaited unboundedly): if closing hangs long enough to exhaust the
  // deadline, the caller is told "timeout" rather than blocking indefinitely, while the close's real
  // eventual outcome is still recorded via the diagnostic log in the background (`closeSession()`'s
  // memoized promise is the same one this race observes, so nothing closes twice). A close() failure
  // that finishes WITHIN the deadline overrides the outcome to a named `failed` result — a turn whose
  // session could not be confirmed closed cleanly must never be treated as a valid, cacheable answer,
  // and must never throw out of this function.
  const closeOutcome = await Promise.race([closeSession(), deadline]);

  if (closeOutcome.kind === "timeout") {
    return { kind: "timeout" };
  }
  clearDeadline();
  if (closeOutcome.kind === "failed") {
    return { kind: "failed", code: closeOutcome.code };
  }

  return { kind: "ok", turn: sendOutcome.turn };
}
