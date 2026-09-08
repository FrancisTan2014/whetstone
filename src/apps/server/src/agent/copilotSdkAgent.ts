import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotClientOptions, PermissionHandler, SessionConfig } from "@github/copilot-sdk";

import { AgentError, isAgentError, type AgentFailureCode } from "./agentFailure.js";
import type { Agent, AgentSession, AgentSessionConfig, AgentTurn } from "./agentSession.js";
import type { CopilotSdkConfig, ReasoningEffort } from "./copilotSdkConfig.js";

// The warm, prompt-only Copilot SDK runtime (#923): a small provider adapter over the official
// `@github/copilot-sdk`, behind the same `Agent` port `cliAgent.ts` implements. The imminent consumer
// (#924's semantic-map lookup API) depends only on `Agent`; nothing here is wired into a product flow
// yet, exactly like `cliAgent.ts` before #906.
//
// The one thing this adapter does that `cliAgent.ts` does not: it keeps ONE Copilot runtime process
// warm and reuses it across independent `open()` calls (each still gets its OWN SDK session and
// history - "warm runtime" is reuse of the process, never reuse of a conversation), started lazily on
// the first call and released after an idle period with no open session. `createCopilotSdkAgentRuntime`
// returns both the `Agent` and a `dispose()` for the caller (a later server shutdown hook, #924+) to
// call explicitly - `dispose` is deliberately NOT part of the `Agent` port, which has no shutdown verb.

// One turn's wall-clock bound, matching the CLI adapter's own bound (`docs/AGENT.md`) so a caller
// sees one consistent timeout regardless of which provider is behind the seam.
const defaultTurnTimeoutMs = 120_000;

// How long a runtime with zero open sessions stays warm before this seam releases it. Long enough that
// a realistic burst of lookups never pays a cold start twice, short enough that an idle server is not
// left holding a Copilot process (and its billed session) indefinitely.
const defaultIdleTimeoutMs = 10 * 60_000;

// ---------------------------------------------------------------------------------------------------
// The injected runtime boundary. Deliberately narrower than the SDK's own `CopilotClient`/
// `CopilotSession` shape - only the four operations this seam needs - so a test drives every lifecycle
// path (lazy start, shared concurrent start, idle disposal, failed-start recovery, denied tools,
// timeout, transport failure) against a small scripted fake, exactly as `AgentCommandRunner` lets
// `cliAgent.test.ts` exercise the CLI adapter with no process spawned.
// ---------------------------------------------------------------------------------------------------

export type CopilotModelSupport = Readonly<{
  id: string;
  supportedReasoningEfforts?: ReadonlyArray<ReasoningEffort>;
}>;

// One turn's outcome as data, not an exception, so the adapter maps it to the seam's own named
// failures in one place - the same shape discipline `AgentCommandOutcome` uses for the CLI adapter.
export type CopilotTurnOutcome =
  | Readonly<{ kind: "ok"; content: string }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "failed"; message: string }>;

export type CopilotRuntimeSession = Readonly<{
  sendAndWait(prompt: string, timeoutMs: number): Promise<CopilotTurnOutcome>;
  disconnect(): Promise<void>;
}>;

export type CopilotRuntimeClient = Readonly<{
  start(): Promise<void>;
  stop(): Promise<void>;
  listModels(): Promise<ReadonlyArray<CopilotModelSupport>>;
  createSession(sessionConfig: AgentSessionConfig): Promise<CopilotRuntimeSession>;
}>;

export type CreateCopilotRuntimeClient = (config: CopilotSdkConfig) => CopilotRuntimeClient;

// ---------------------------------------------------------------------------------------------------
// Pure, fully unit-tested prompt-only configuration. Kept as plain functions returning SDK-shaped data
// rather than folded into the real factory below, precisely so "denied tools" and "permission denial"
// are exercised directly, without needing the real SDK client or a live runtime.
// ---------------------------------------------------------------------------------------------------

// Every tool-execution request is denied, by construction: this seam grants the agent nothing (#923,
// following the "No tools, by design" rule `cliAgent.ts` already enforces). `availableTools: []` on the
// session already leaves nothing to request permission for; this handler is defense-in-depth so a
// request that reaches it anyway (a future SDK/runtime tool this seam has not opted into) is refused
// explicitly rather than left pending forever.
export const denyAllCopilotPermissions: PermissionHandler = () => ({
  feedback: "Whetstone's Copilot runtime is prompt-only; tool use is always denied.",
  kind: "reject"
});

// Client-level options: `mode: "empty"` is the SDK's own multi-user-server posture (disables optional
// features by default and requires `availableTools` on every session, enforced below) - the opposite
// of its `"copilot-cli"` default, which the SDK's own docs warn against for a server. `baseDirectory`
// keeps this runtime's session state out of a developer's personal `~/.copilot`.
export function buildCopilotClientOptions(config: CopilotSdkConfig): CopilotClientOptions {
  return {
    baseDirectory: config.copilotHome,
    clientInfo: { applicationName: "whetstone" },
    mode: "empty"
  };
}

// Session-level options: the fixed model/effort, an explicitly empty tool surface, a deny-all
// permission handler, and every ambient-behavior flag turned off by name rather than left to a mode
// default - so a future SDK default change cannot silently reopen a surface this seam closed.
// `instructions` becomes the session's persistent system message (sent once, unlike the CLI adapter's
// per-turn restatement, because an SDK session actually remembers it).
export function buildCopilotSessionConfig(
  config: CopilotSdkConfig,
  sessionConfig: AgentSessionConfig
): SessionConfig {
  const instructions = sessionConfig.instructions?.trim();
  return {
    availableTools: [],
    customAgentsLocalOnly: true,
    manageScheduleEnabled: false,
    model: config.model,
    onPermissionRequest: denyAllCopilotPermissions,
    reasoningEffort: config.reasoningEffort,
    skipCustomInstructions: true,
    ...(instructions !== undefined && instructions.length > 0
      ? { systemMessage: { content: instructions } }
      : {})
  };
}

// ---------------------------------------------------------------------------------------------------
// Lifecycle: lazy, concurrency-safe warm start; idle disposal that never reaps active work; honest
// failed-start recovery (no automatic duplicate paid retry); deterministic shutdown disposal.
// ---------------------------------------------------------------------------------------------------

type ReadyRuntime = Readonly<{ client: CopilotRuntimeClient }>;

type WarmState =
  | Readonly<{ kind: "cold" }>
  | Readonly<{ kind: "starting"; pending: Promise<ReadyRuntime> }>
  | Readonly<{ kind: "ready"; runtime: ReadyRuntime }>
  | Readonly<{ kind: "disposed" }>;

export type CopilotSdkLogRecord = Readonly<{
  durationMs: number;
  event: "runtime_start" | "runtime_idle_dispose" | "session_open" | "agent_turn";
  status: "ok" | AgentFailureCode;
}>;

export type CopilotSdkLogger = (record: CopilotSdkLogRecord) => void;

// The timer boundary, injected so idle disposal is tested by triggering it directly rather than
// waiting on (or faking) real wall-clock timers.
export type CopilotIdleScheduler = Readonly<{
  schedule(callback: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}>;

const defaultIdleScheduler: CopilotIdleScheduler = {
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  schedule: (callback, ms) => setTimeout(callback, ms)
};

export type CopilotSdkAgentDependencies = Readonly<{
  config: CopilotSdkConfig;
  // The real Copilot SDK factory by default; injected in every test so no test touches the SDK or a
  // real runtime process.
  createRuntimeClient?: CreateCopilotRuntimeClient;
  idleScheduler?: CopilotIdleScheduler;
  idleTimeoutMs?: number;
  turnTimeoutMs?: number;
  now?: () => number;
  log?: CopilotSdkLogger;
}>;

export type CopilotSdkAgentRuntime = Readonly<{
  agent: Agent;
  // Deterministic disposal for backend shutdown: stops a ready runtime, or waits for an in-flight
  // start to settle and stops that. NOT part of the `Agent` port - the port has no shutdown verb, and
  // this stops the shared runtime, not one conversation.
  dispose(): Promise<void>;
}>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Preserve an already-classified failure (e.g. `agent_unsupported_model` raised while validating the
// runtime's own reported models) instead of re-wrapping it under a generic fallback code.
function toAgentError(error: unknown, fallbackCode: AgentFailureCode, prefix: string): AgentError {
  return isAgentError(error)
    ? error
    : new AgentError(fallbackCode, `${prefix}: ${describeError(error)}`);
}

// Some Copilot plans/accounts expose no real per-model catalog at all: `listModels()` reports a
// single generic "auto" routing placeholder with no declared capabilities (verified against the live
// SDK transport, #923), yet the connected runtime still honors an explicit `model` in that state. This
// seam cannot honestly conclude a configured model is unsupported from a placeholder alone, so it does
// not gate on one — gating here would reject this issue's own default (`gpt-5.4`) on every account in
// that state, which is a worse outcome than the narrow validation gap it would close.
function isGenericAutoPlaceholder(models: ReadonlyArray<CopilotModelSupport>): boolean {
  return (
    models.length === 1 &&
    models[0]?.id.toLowerCase() === "auto" &&
    models[0]?.supportedReasoningEfforts === undefined
  );
}

// Does the connected runtime support the configured model and, if so, the configured reasoning effort?
// Named by model/effort rather than a generic "startup failed" so an operator fixes the actual
// misconfiguration instead of guessing (#923: "unsupported settings fail with a named remedy").
function findUnsupportedModelReason(
  models: ReadonlyArray<CopilotModelSupport>,
  config: CopilotSdkConfig
): string | undefined {
  const entry = models.find((model) => model.id === config.model);
  if (entry === undefined) {
    if (isGenericAutoPlaceholder(models)) {
      return undefined;
    }
    const known = models.map((model) => model.id).join(", ") || "none reported";
    return (
      `Model "${config.model}" is not available from this Copilot runtime (available: ${known}). ` +
      "Set AGENT_COPILOT_MODEL to one of them (see docs/AGENT.md)."
    );
  }

  const supported = entry.supportedReasoningEfforts ?? [];
  if (!supported.includes(config.reasoningEffort)) {
    const known = supported.length > 0 ? supported.join(", ") : "none";
    return (
      `Model "${config.model}" does not support reasoning effort "${config.reasoningEffort}" ` +
      `(supported: ${known}). Set AGENT_COPILOT_REASONING_EFFORT to one of them, or choose a ` +
      "different AGENT_COPILOT_MODEL (see docs/AGENT.md)."
    );
  }
  return undefined;
}

export function createCopilotSdkAgentRuntime(
  dependencies: CopilotSdkAgentDependencies
): CopilotSdkAgentRuntime {
  const {
    config,
    createRuntimeClient = createRealCopilotRuntimeClient,
    idleScheduler = defaultIdleScheduler,
    idleTimeoutMs = defaultIdleTimeoutMs,
    turnTimeoutMs = defaultTurnTimeoutMs,
    now = Date.now,
    log = () => {}
  } = dependencies;

  let warmState: WarmState = { kind: "cold" };
  let activeSessionCount = 0;
  let idleTimerHandle: unknown;

  function cancelIdleTimer(): void {
    if (idleTimerHandle !== undefined) {
      idleScheduler.cancel(idleTimerHandle);
      idleTimerHandle = undefined;
    }
  }

  // Scheduled only while zero sessions are open; opening a session always cancels it first. Never
  // reaps active work: the fired callback re-checks both the count and that the runtime is still
  // "ready", so a runtime that was disposed (or already released) in the meantime is left alone.
  function scheduleIdleTimer(): void {
    cancelIdleTimer();
    idleTimerHandle = idleScheduler.schedule(() => {
      idleTimerHandle = undefined;
      if (activeSessionCount !== 0 || warmState.kind !== "ready") {
        return;
      }
      const runtime = warmState.runtime;
      warmState = { kind: "cold" };
      const startedAt = now();
      void runtime.client.stop().then(
        () => log({ durationMs: now() - startedAt, event: "runtime_idle_dispose", status: "ok" }),
        () =>
          log({
            durationMs: now() - startedAt,
            event: "runtime_idle_dispose",
            status: "agent_transport_failed"
          })
      );
    }, idleTimeoutMs);
  }

  function noteSessionOpened(): void {
    activeSessionCount += 1;
    cancelIdleTimer();
  }

  function noteSessionClosed(): void {
    activeSessionCount = Math.max(0, activeSessionCount - 1);
    if (activeSessionCount === 0 && warmState.kind === "ready") {
      scheduleIdleTimer();
    }
  }

  async function startRuntime(): Promise<ReadyRuntime> {
    const startedAt = now();
    const client = createRuntimeClient(config);
    try {
      await client.start();
      const models = await client.listModels();
      const unsupportedReason = findUnsupportedModelReason(models, config);
      if (unsupportedReason !== undefined) {
        throw new AgentError("agent_unsupported_model", unsupportedReason);
      }
      log({ durationMs: now() - startedAt, event: "runtime_start", status: "ok" });
      return { client };
    } catch (rawError) {
      // Deterministic cleanup for a failed start (#923): never leave a partially-started runtime
      // resident just because it failed validation or its own `start()` rejected.
      await client.stop().catch(() => {});
      const failure = toAgentError(
        rawError,
        "agent_startup_failed",
        "The Copilot runtime failed to start"
      );
      log({ durationMs: now() - startedAt, event: "runtime_start", status: failure.code });
      throw failure;
    }
  }

  // Lazy, concurrency-safe start: the first caller creates the one in-flight attempt and every
  // concurrent caller observes and awaits that same promise (set synchronously, before any `await`, so
  // no interleaving caller can start a second one). A failed attempt resets to `"cold"` so the NEXT
  // explicit call gets a fresh attempt - this call's own concurrent waiters all see the one failure
  // rather than each silently retrying (and each potentially re-billing) on its own.
  function ensureRuntime(): Promise<ReadyRuntime> {
    if (warmState.kind === "ready") {
      return Promise.resolve(warmState.runtime);
    }
    if (warmState.kind === "starting") {
      return warmState.pending;
    }
    if (warmState.kind === "disposed") {
      return Promise.reject(
        new AgentError(
          "agent_startup_failed",
          "The Copilot runtime has been shut down; no new session can be opened."
        )
      );
    }

    const pending: Promise<ReadyRuntime> = startRuntime().then(
      (runtime) => {
        if (warmState.kind === "starting" && warmState.pending === pending) {
          warmState = { kind: "ready", runtime };
        }
        return runtime;
      },
      (error: unknown) => {
        if (warmState.kind === "starting" && warmState.pending === pending) {
          warmState = { kind: "cold" };
        }
        throw error;
      }
    );
    warmState = { kind: "starting", pending };
    return pending;
  }

  async function open(sessionConfig: AgentSessionConfig): Promise<AgentSession> {
    const runtime = await ensureRuntime();
    noteSessionOpened();

    const startedAt = now();
    let runtimeSession: CopilotRuntimeSession;
    try {
      runtimeSession = await runtime.client.createSession(sessionConfig);
    } catch (rawError) {
      noteSessionClosed();
      const failure = toAgentError(
        rawError,
        "agent_transport_failed",
        "The Copilot runtime could not open a session"
      );
      log({ durationMs: now() - startedAt, event: "session_open", status: failure.code });
      throw failure;
    }
    log({ durationMs: now() - startedAt, event: "session_open", status: "ok" });

    let closed = false;
    return Object.freeze({
      async send(prompt: string): Promise<AgentTurn> {
        if (closed) {
          throw new AgentError(
            "agent_session_closed",
            "The Copilot session is closed; open a new session to keep talking."
          );
        }

        const turnStartedAt = now();
        const outcome = await runtimeSession.sendAndWait(prompt, turnTimeoutMs);
        log({
          durationMs: now() - turnStartedAt,
          event: "agent_turn",
          status:
            outcome.kind === "ok"
              ? "ok"
              : outcome.kind === "timeout"
                ? "agent_timeout"
                : "agent_transport_failed"
        });

        if (outcome.kind === "timeout") {
          throw new AgentError(
            "agent_timeout",
            "The Copilot runtime did not finish the turn within its time limit."
          );
        }
        if (outcome.kind === "failed") {
          throw new AgentError(
            "agent_transport_failed",
            `The Copilot runtime failed the turn: ${outcome.message}`
          );
        }
        return { text: outcome.content };
      },
      async close(): Promise<void> {
        if (closed) {
          return;
        }
        closed = true;
        noteSessionClosed();
        await runtimeSession.disconnect().catch(() => {});
      }
    });
  }

  async function dispose(): Promise<void> {
    cancelIdleTimer();
    const previous = warmState;
    warmState = { kind: "disposed" };

    if (previous.kind === "ready") {
      await previous.runtime.client.stop().catch(() => {});
      return;
    }
    if (previous.kind === "starting") {
      await previous.pending.then(
        (runtime) => runtime.client.stop().catch(() => {}),
        () => undefined
      );
    }
  }

  return Object.freeze({ agent: Object.freeze({ open }), dispose });
}

// ---------------------------------------------------------------------------------------------------
// The real factory: the only code in this module that constructs a live `CopilotClient`. Reaches a
// local process/network and is exercised only by the bounded live smoke (docs/AGENT.md), never by unit
// coverage - exactly the precedent `llmModel.ts` sets for `ollamaLanguageModel`.
// ---------------------------------------------------------------------------------------------------

/* v8 ignore start -- constructs the real Copilot SDK client and spawns its runtime process; covered only by the bounded live smoke, never unit coverage */
function isSdkTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}

function createRealCopilotRuntimeClient(config: CopilotSdkConfig): CopilotRuntimeClient {
  const client = new CopilotClient(buildCopilotClientOptions(config));

  return {
    async createSession(sessionConfig) {
      const session = await client.createSession(buildCopilotSessionConfig(config, sessionConfig));
      return {
        async disconnect() {
          await session.disconnect();
        },
        async sendAndWait(prompt, timeoutMs) {
          try {
            const event = await session.sendAndWait(prompt, timeoutMs);
            if (event === undefined) {
              return {
                kind: "failed",
                message: "the Copilot runtime reported no assistant message for this turn"
              };
            }
            return { content: event.data.content, kind: "ok" };
          } catch (error) {
            return isSdkTimeoutError(error)
              ? { kind: "timeout" }
              : { kind: "failed", message: describeError(error) };
          }
        }
      };
    },
    async listModels() {
      const models = await client.listModels();
      return models.map((model) =>
        model.supportedReasoningEfforts === undefined
          ? { id: model.id }
          : { id: model.id, supportedReasoningEfforts: model.supportedReasoningEfforts }
      );
    },
    start: () => client.start(),
    stop: () => client.stop().then(() => {})
  };
}
/* v8 ignore stop */
