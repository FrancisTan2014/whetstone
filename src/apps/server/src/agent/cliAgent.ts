import { randomUUID } from "node:crypto";

import { AgentError, type AgentFailureCode } from "./agentFailure.js";
import {
  spawnAgentCommand,
  type AgentCommandOutcome,
  type AgentCommandRunner
} from "./agentProcess.js";
import type { Agent, AgentSession, AgentSessionConfig, AgentTurn } from "./agentSession.js";

// The provider-neutral local agent adapter (#904): it drives a configured, locally installed agentic
// CLI through one small executable protocol and maps its JSON into an `AgentTurn`. Its public config is
// deliberately only an executable path + a model identifier — no vendor name, no per-CLI flag table —
// so Whetstone never learns that any specific tool exists. Adapting a particular CLI (Qwen Code, Gemini
// CLI, Claude Code, GitHub Copilot CLI, …) is the job of a small external shim that honours the
// protocol documented in `docs/AGENT.md`. Untrusted process output is validated here, at the boundary,
// before anything is trusted inward.
//
// No tool is granted to the provider: no tool flag is passed and no allowlist is exposed. The seam
// starts closed, so a local agent structurally cannot become a second writer of Whetstone's data.

// The executable protocol version this Whetstone build speaks. A configured provider must answer the
// `--contract-version` probe with exactly this string, starting no session, so a stale or incompatible
// provider is detectable before any prompt is handed to it.
export const agentContractVersion = "1";

// What a provider is called in operational logs when its probe reported no identifier. Never the
// binary path — an environment value must not reach a log line.
export const unknownProviderIdentifier = "unknown";

// The readiness probe loads nothing, so it must answer fast; a provider that cannot is unusable and
// says so at boot instead of stalling startup.
const probeTimeoutMs = 10_000;

// One turn's wall-clock bound. Local agentic work is slow, but an unresponsive provider must never hang
// a caller unbounded — on expiry the child is terminated and the turn fails as `agent_timeout`.
const turnTimeoutMs = 120_000;

export type CliAgentConfig = Readonly<{
  binaryPath: string;
  modelIdentifier: string;
}>;

// What the readiness probe reports: which provider answered, and whether it can resume conversation
// state across invocations. `sessions` is never assumed — an absent or non-boolean flag means false, so
// a provider that only understands one-shot turns keeps working unchanged.
export type AgentProbe = Readonly<{
  provider: string;
  sessions: boolean;
}>;

// Operational log records for the seam. Deliberately only the provider identifier, the outcome status,
// and the duration: prompt text, response text, session content, and environment values never reach a
// log line (the same standard `docs/MCP.md` sets for the MCP tools).
export type AgentLogRecord = Readonly<{
  durationMs: number;
  event: "agent_probe" | "agent_turn";
  provider: string;
  status: "ok" | AgentFailureCode;
}>;

export type AgentLogger = (record: AgentLogRecord) => void;

export type CliAgentDependencies = Readonly<{
  config: CliAgentConfig;
  // The OS-process boundary, injected so every adapter path is exercised without spawning a real agent.
  run?: AgentCommandRunner;
  // The wall clock behind logged durations, injected so tests can assert exact values.
  now?: () => number;
  // Where operational records go. Defaults to dropping them: this seam is not wired into a server yet
  // and must never reach for `console` itself.
  log?: AgentLogger;
  // One conversation id per opened session, sent as `--session` only when the probe reports support.
  // Whetstone owns the id and treats it as opaque; a provider (or its shim) keys its stored
  // conversation state on it.
  createSessionId?: () => string;
}>;

type ResolvedDependencies = Readonly<{
  config: CliAgentConfig;
  createSessionId: () => string;
  log: AgentLogger;
  now: () => number;
  run: AgentCommandRunner;
}>;

type ProbeResult =
  | Readonly<{ ok: true; probe: AgentProbe }>
  | Readonly<{ ok: false; failure: AgentError }>;

type TurnResult =
  | Readonly<{ ok: true; turn: AgentTurn }>
  | Readonly<{ ok: false; failure: AgentError }>;

function resolveDependencies(dependencies: CliAgentDependencies): ResolvedDependencies {
  return {
    config: dependencies.config,
    createSessionId: dependencies.createSessionId ?? randomUUID,
    log: dependencies.log ?? (() => {}),
    now: dependencies.now ?? Date.now,
    run: dependencies.run ?? spawnAgentCommand
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

// The child's stderr, or a stable description when it said nothing, so a failure is never reported as
// an empty message.
function describeFailedRun(outcome: Readonly<{ exitCode: number | null; stderr: string }>): string {
  const detail = outcome.stderr.trim();
  return detail.length > 0 ? detail : `it exited with code ${String(outcome.exitCode)}`;
}

function probeFailure(reason: string): ProbeResult {
  return {
    failure: new AgentError(
      "agent_probe_failed",
      `The local agent did not answer its readiness probe: ${reason}`
    ),
    ok: false
  };
}

// Validate the `--contract-version` response once, here at the boundary. A provider that reports a
// different contract version is rejected outright rather than being driven with a protocol it does not
// speak.
function readProbeOutcome(outcome: AgentCommandOutcome): ProbeResult {
  if (outcome.kind === "timeout") {
    return probeFailure("it did not respond in time.");
  }
  if (outcome.kind === "failed") {
    return probeFailure(describeFailedRun(outcome));
  }

  const root = asRecord(parseJson(outcome.stdout));
  if (root === undefined) {
    return probeFailure("it did not print a JSON object.");
  }
  if (root.contractVersion !== agentContractVersion) {
    return probeFailure(
      `it reported contract version ${String(root.contractVersion)}, not ${agentContractVersion}.`
    );
  }

  const provider = typeof root.provider === "string" ? root.provider.trim() : "";
  return {
    ok: true,
    probe: {
      provider: provider.length > 0 ? provider : unknownProviderIdentifier,
      sessions: root.sessions === true
    }
  };
}

// Validate one turn's response. `text` is the whole required contract; unknown keys are ignored so a
// provider may report extra detail without breaking the seam. Malformed output fails the turn by name —
// never a partial or fabricated answer.
function readTurnOutcome(outcome: AgentCommandOutcome): TurnResult {
  if (outcome.kind === "timeout") {
    return {
      failure: new AgentError(
        "agent_timeout",
        "The local agent did not finish the turn within its time limit and was stopped."
      ),
      ok: false
    };
  }
  if (outcome.kind === "failed") {
    return {
      failure: new AgentError(
        "agent_exit_failed",
        `The local agent failed the turn: ${describeFailedRun(outcome)}`
      ),
      ok: false
    };
  }

  const text = asRecord(parseJson(outcome.stdout))?.text;
  if (typeof text !== "string") {
    return {
      failure: new AgentError(
        "agent_malformed_response",
        "The local agent's response did not match the expected turn contract."
      ),
      ok: false
    };
  }
  return { ok: true, turn: { text } };
}

// The readiness probe arguments: ask for the protocol version and nothing else. The prompt channel is
// empty for a probe, so a provider that honours the protocol starts no session and loads no model.
function buildProbeArgs(): ReadonlyArray<string> {
  return ["--contract-version"];
}

// One turn's arguments: the model identifier, a JSON output request, and — only for a provider that
// reported session support — the conversation id. No tool flag is passed here, by design (#904).
function buildTurnArgs(
  config: CliAgentConfig,
  sessionId: string | undefined
): ReadonlyArray<string> {
  const base = ["--model", config.modelIdentifier, "--output", "json"];
  return sessionId === undefined ? base : [...base, "--session", sessionId];
}

// The stdin payload for one turn. Standing instructions are restated ahead of every prompt because a
// provider without session support has no memory of the previous invocation; restating them costs a
// provider that does keep state nothing but a repeated preamble.
function composeTurnInput(prompt: string, instructions: string | undefined): string {
  return instructions === undefined || instructions.trim().length === 0
    ? prompt
    : `${instructions}\n\n${prompt}`;
}

async function probe(dependencies: ResolvedDependencies): Promise<AgentProbe> {
  const { config, log, now, run } = dependencies;
  const startedAt = now();
  const result = readProbeOutcome(
    await run({
      args: buildProbeArgs(),
      binaryPath: config.binaryPath,
      stdin: "",
      timeoutMs: probeTimeoutMs
    })
  );

  log({
    durationMs: now() - startedAt,
    event: "agent_probe",
    provider: result.ok ? result.probe.provider : unknownProviderIdentifier,
    status: result.ok ? "ok" : result.failure.code
  });

  if (!result.ok) {
    throw result.failure;
  }
  return result.probe;
}

// The boot readiness probe, standalone: `agentHealth.ts` asks whether a configured provider answers,
// without opening a conversation.
export function probeCliAgent(dependencies: CliAgentDependencies): Promise<AgentProbe> {
  return probe(resolveDependencies(dependencies));
}

function openSession(
  dependencies: ResolvedDependencies,
  reported: AgentProbe,
  sessionConfig: AgentSessionConfig
): AgentSession {
  const { config, log, now, run } = dependencies;
  // A provider that cannot resume conversation state gets no `--session` argument at all, rather than
  // an id it would have to ignore.
  const sessionId = reported.sessions ? dependencies.createSessionId() : undefined;
  let closed = false;

  return Object.freeze({
    close(): Promise<void> {
      // One-shot invocation leaves nothing resident to tear down, so closing only ends the
      // conversation: a further turn would silently start a different one, and is refused by name.
      closed = true;
      return Promise.resolve();
    },
    async send(prompt: string): Promise<AgentTurn> {
      if (closed) {
        throw new AgentError(
          "agent_session_closed",
          "The local agent session is closed; open a new session to keep talking."
        );
      }

      const startedAt = now();
      const result = readTurnOutcome(
        await run({
          args: buildTurnArgs(config, sessionId),
          binaryPath: config.binaryPath,
          stdin: composeTurnInput(prompt, sessionConfig.instructions),
          timeoutMs: turnTimeoutMs
        })
      );

      log({
        durationMs: now() - startedAt,
        event: "agent_turn",
        provider: reported.provider,
        status: result.ok ? "ok" : result.failure.code
      });

      if (!result.ok) {
        throw result.failure;
      }
      return result.turn;
    }
  });
}

// Build the adapter. Opening a conversation probes the configured provider first, so a stale or absent
// executable fails before a prompt is written and the session's capability flags are always current
// (a provider installed after boot needs no restart).
export function createCliAgent(dependencies: CliAgentDependencies): Agent {
  const resolved = resolveDependencies(dependencies);

  return Object.freeze({
    async open(config: AgentSessionConfig): Promise<AgentSession> {
      return openSession(resolved, await probe(resolved), config);
    }
  });
}
