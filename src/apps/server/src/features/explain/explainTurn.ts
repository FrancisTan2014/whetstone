import type { ExplainUnavailableReason } from "@whetstone/contracts";

import { isAgentError } from "../../agent/agentFailure.js";
import type { Agent, AgentSessionConfig, AgentTurn } from "../../agent/agentSession.js";

// The consumer-owned request deadline for one explanation turn (#924). The warm Copilot runtime
// (`copilotSdkAgent.ts`, #923) already owns a robust internal turn deadline, but that only bounds
// `session.send()` — never the `agent.open()` call that precedes it. This seam bounds the WHOLE
// request (session setup included), and — critically — a session that finishes opening only AFTER
// this deadline has already fired is closed immediately and NEVER handed a prompt: `send()` is never
// called on it, so a slow-to-open session can never still rack up a paid turn after the caller has
// already been told the request timed out.

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

export type RunExplainTurnDependencies = Readonly<{
  agent: Agent;
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
  // Every other agent-seam failure (transport failure, an internal runtime timeout that narrowly beat
  // this owned deadline, a closed-session error that should never occur given this module's own
  // lifecycle) is reported as the generic "the runtime itself failed" reason — never the raw message.
  return "transport_failed";
}

// Run exactly one turn under one owned deadline covering `agent.open()` AND `session.send()` together.
export async function runExplainTurn(
  dependencies: RunExplainTurnDependencies
): Promise<ExplainTurnOutcome> {
  const scheduler = dependencies.scheduler ?? defaultScheduler;
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
    // sent a prompt — the caller has already moved on. A late open failure needs no further action; a
    // late-opened session is drained via its own close() and any close failure is swallowed here (the
    // caller already reports "timeout" and has nothing more useful to act on from a post-hoc cleanup
    // failure it can no longer retry).
    void sessionPromise.then((session) => session.close()).catch(() => {});
    return { kind: "timeout" };
  }

  if (openOutcome.kind === "open_failed") {
    clearDeadline();
    return { kind: "failed", code: mapFailureCode(openOutcome.error) };
  }

  const { session } = openOutcome;
  const sendOutcome = await Promise.race([
    session.send(dependencies.prompt).then(
      (turn) => ({ kind: "ok", turn }) as const,
      (error: unknown) => ({ kind: "send_failed", error }) as const
    ),
    deadline
  ]);
  clearDeadline();

  if (sendOutcome.kind === "timeout") {
    await session.close().catch(() => {});
    return { kind: "timeout" };
  }

  if (sendOutcome.kind === "send_failed") {
    await session.close().catch(() => {});
    return { kind: "failed", code: mapFailureCode(sendOutcome.error) };
  }

  await session.close();
  return { kind: "ok", turn: sendOutcome.turn };
}
