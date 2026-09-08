import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
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

// Bound for the SDK's own documented `stop()`-fails-or-hangs remedy, `forceStop()` (client.d.ts): used
// only as a fallback when `stop()` itself reports (or throws) a cleanup failure, so a stuck forceStop
// can never hang this seam's own shutdown/idle-release/invalidation paths forever.
const defaultForceStopTimeoutMs = 5_000;

// ---------------------------------------------------------------------------------------------------
// The injected runtime boundary. Deliberately narrower than the SDK's own `CopilotClient`/
// `CopilotSession` shape - only the operations this seam needs - so a test drives every lifecycle
// path (lazy start, shared concurrent start, idle disposal, failed-start recovery, denied tools,
// timeout+abort, transport failure, failed-runtime invalidation, serialized stop/start) against a
// small scripted fake, exactly as `AgentCommandRunner` lets `cliAgent.test.ts` exercise the CLI adapter
// with no process spawned.
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
  // Requests real cancellation of whatever this session is currently processing, through the SDK's
  // one supported cancellation boundary (`session.abort()`, session.d.ts). Used both by a timed-out
  // `sendAndWait` (internally) and by `close()` when it must drain an in-flight turn before releasing
  // the session (#923).
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}>;

export type CopilotRuntimeClient = Readonly<{
  start(): Promise<void>;
  // Resolves the messages describing every cleanup failure (empty = fully clean), mirroring the real
  // SDK's own `client.stop(): Promise<Error[]>` contract (client.d.ts) - never a bare success/failure
  // boolean a caller cannot act on, and never silently swallowed into "it worked" (#923).
  stop(): Promise<ReadonlyArray<string>>;
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
    // Pin the transport to the SDK's own stdio-spawned-child-process path explicitly, instead of
    // leaving `connection` unset. Unset falls through to `CopilotClient`'s own
    // `resolveDefaultConnection()` (client.js), which honors the ambient `COPILOT_SDK_DEFAULT_CONNECTION`
    // env var and switches to the SDK's experimental in-process (FFI) transport when it is set to
    // `"inprocess"` - a transport whose own docs (types.d.ts) say it does NOT honor a per-client
    // `baseDirectory` or `env` at all, because the native runtime loads into, and inherits the
    // environment of, the *host* process rather than a spawned child. An operator's ambient env value
    // must never silently change this seam's process isolation and scratch-directory guarantees.
    connection: RuntimeConnection.forStdio({}),
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
    // Explicitly off, by name: infinite sessions default to *enabled* (types.d.ts) even under
    // `mode: "empty"`, unlike the several feature flags `"empty"` already zeroes out by itself (skills,
    // MCP OAuth persistence, the cross-session store, memory...). Left unset, every session here would
    // get automatic background context compaction and a persisted `workspacePath` on disk that this
    // seam never asked for and neither #924 nor #925 need.
    infiniteSessions: { enabled: false },
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
// failed-start recovery (no automatic duplicate paid retry); serialized stop/start ownership; a failed
// runtime generation is invalidated rather than reused; deterministic, idempotent shutdown disposal
// that fences a racing open().
// ---------------------------------------------------------------------------------------------------

type ReadyRuntime = Readonly<{ client: CopilotRuntimeClient }>;

type WarmState =
  | Readonly<{ kind: "cold" }>
  | Readonly<{ kind: "starting"; pending: Promise<ReadyRuntime> }>
  | Readonly<{ kind: "ready"; runtime: ReadyRuntime }>
  // A stop is in flight for the CURRENT slot (idle release, explicit invalidation after a failure, or
  // the "ready" half of an explicit dispose()). No new start may begin until this settles: `ensureRuntime`
  // waits it out first, so at most one live-or-starting runtime for this slot ever exists at a time.
  | Readonly<{ kind: "stopping"; pending: Promise<void> }>
  | Readonly<{ kind: "disposed" }>;

export type CopilotSdkLogRecord = Readonly<{
  durationMs: number;
  event: "runtime_start" | "runtime_stop" | "runtime_invalidate" | "session_open" | "agent_turn";
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
  // Deterministic, idempotent disposal for backend shutdown: stops a ready runtime, waits out and
  // stops an in-flight start, or waits out an in-flight stop - whichever applies. Every caller (however
  // many times `dispose()` is called) awaits the SAME shutdown completion, never a second independent
  // one. NOT part of the `Agent` port - the port has no shutdown verb, and this stops the shared
  // runtime, not one conversation.
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
  let disposePromise: Promise<void> | undefined;

  function cancelIdleTimer(): void {
    if (idleTimerHandle !== undefined) {
      idleScheduler.cancel(idleTimerHandle);
      idleTimerHandle = undefined;
    }
  }

  async function safeStop(client: CopilotRuntimeClient): Promise<ReadonlyArray<string>> {
    try {
      return await client.stop();
    } catch (rawError) {
      return [describeError(rawError)];
    }
  }

  // The one place a warm runtime is actually released: moves the slot to "stopping" IMMEDIATELY
  // (synchronously, before the first await) so a concurrent `ensureRuntime()` call can never observe
  // "ready" for a client that is already being torn down and spawn a redundant replacement while this
  // one is still stopping. Settles back to "cold" only if nothing else has since claimed the slot (a
  // concurrent `dispose()` moving straight to "disposed" is never overwritten back to "cold").
  function beginStop(
    runtimeToStop: ReadyRuntime,
    event: CopilotSdkLogRecord["event"]
  ): Promise<void> {
    const startedAt = now();
    const pending: Promise<void> = safeStop(runtimeToStop.client).then((errors) => {
      log({
        durationMs: now() - startedAt,
        event,
        status: errors.length === 0 ? "ok" : "agent_transport_failed"
      });
      if (warmState.kind === "stopping" && warmState.pending === pending) {
        warmState = { kind: "cold" };
      }
    });
    warmState = { kind: "stopping", pending };
    return pending;
  }

  // Scheduled only while zero sessions are open; opening a session always cancels it first. Never
  // reaps active work: the fired callback re-checks both the count and that the runtime is still
  // "ready", so a runtime that was disposed, invalidated, or already released in the meantime is left
  // alone.
  function scheduleIdleTimer(): void {
    cancelIdleTimer();
    idleTimerHandle = idleScheduler.schedule(() => {
      idleTimerHandle = undefined;
      if (activeSessionCount !== 0 || warmState.kind !== "ready") {
        return;
      }
      beginStop(warmState.runtime, "runtime_stop");
    }, idleTimeoutMs);
  }

  function noteSessionOpened(): void {
    activeSessionCount += 1;
    cancelIdleTimer();
  }

  function noteSessionClosed(): void {
    // Always paired 1:1 with an earlier `noteSessionOpened()` (every call site above closes over one
    // successfully-counted open, and each session's own `close()` is idempotent), so ownership can
    // never actually underflow; asserting the real count here rather than silently clamping it with
    // `Math.max` would surface a real accounting bug instead of hiding one (#923).
    activeSessionCount -= 1;
    if (activeSessionCount === 0 && warmState.kind === "ready") {
      scheduleIdleTimer();
    }
  }

  // A runtime that just failed a client-level operation (opening a session, or a turn transport
  // failure) is not trustworthy for the NEXT explicit call either: invalidate this exact generation -
  // stopping it through the same serialized path idle disposal uses - so a later `open()` gets a fresh
  // runtime instead of silently reusing a dead transport indefinitely (#923). Guarded by reference
  // identity so a failure from a stale generation can never tear down a runtime that has since been
  // replaced (or is already being disposed).
  function invalidateRuntimeAfterFailure(runtime: ReadyRuntime): void {
    if (warmState.kind === "ready" && warmState.runtime === runtime) {
      beginStop(runtime, "runtime_invalidate");
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
      // resident just because it failed validation or its own `start()` rejected. The cleanup outcome
      // is itself observable - a real cleanup failure never masquerades as "it worked" - without
      // masking the original startup failure the caller actually needs to see.
      const cleanupErrors = await safeStop(client);
      const failure = toAgentError(
        rawError,
        "agent_startup_failed",
        "The Copilot runtime failed to start"
      );
      log({ durationMs: now() - startedAt, event: "runtime_start", status: failure.code });
      if (cleanupErrors.length > 0) {
        log({
          durationMs: now() - startedAt,
          event: "runtime_stop",
          status: "agent_transport_failed"
        });
      }
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
    if (warmState.kind === "stopping") {
      // Serialize: never start a replacement while the previous runtime for this slot is still
      // mid-stop (#923) - wait for it to fully settle, then re-evaluate (it will have become "cold",
      // or "disposed" if a concurrent dispose() raced it).
      return warmState.pending.then(() => ensureRuntime());
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
    if (warmState.kind === "disposed") {
      // A concurrent dispose() settled while this call's ensureRuntime() was still in flight: never
      // let a pending open create a session on a runtime shutdown has already claimed (#923) - fail by
      // the same name ensureRuntime() itself uses for this state, rather than silently proceeding.
      throw new AgentError(
        "agent_startup_failed",
        "The Copilot runtime has been shut down; no new session can be opened."
      );
    }
    noteSessionOpened();

    const startedAt = now();
    let runtimeSession: CopilotRuntimeSession;
    try {
      runtimeSession = await runtime.client.createSession(sessionConfig);
    } catch (rawError) {
      noteSessionClosed();
      invalidateRuntimeAfterFailure(runtime);
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
    let turnInFlight: Promise<CopilotTurnOutcome> | undefined;

    return Object.freeze({
      async send(prompt: string): Promise<AgentTurn> {
        if (closed) {
          throw new AgentError(
            "agent_session_closed",
            "The Copilot session is closed; open a new session to keep talking."
          );
        }

        const turnStartedAt = now();
        const outcomePromise = runtimeSession.sendAndWait(prompt, turnTimeoutMs);
        turnInFlight = outcomePromise;
        let outcome: CopilotTurnOutcome;
        try {
          outcome = await outcomePromise;
        } finally {
          if (turnInFlight === outcomePromise) {
            turnInFlight = undefined;
          }
        }

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
          // A runtime-reported turn failure (not a timeout) means the warm runtime's own transport is
          // suspect, not just this one turn - invalidate it so the next explicit call gets a healthy
          // runtime (#923). This call still fails honestly; nothing here retries it automatically.
          invalidateRuntimeAfterFailure(runtime);
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
        // Captured once, up front: `turnInFlight` itself is cleared by `send()`'s own `finally` block
        // as soon as the awaited turn settles, which can happen concurrently with this very drain (the
        // abort triggers that settlement). Re-reading the outer mutable `turnInFlight` after an
        // `await` below could observe `undefined` if that race wins, throwing instead of draining.
        const inFlightTurn = turnInFlight;
        if (inFlightTurn !== undefined) {
          // Cancel and drain the in-flight turn through the SDK's own abort boundary BEFORE this
          // session stops counting toward the runtime's active work - otherwise idle disposal (or a
          // concurrent dispose()) could reap the runtime while a turn it started is still actually
          // running server-side, and this session's close() would return before that turn's own
          // cleanup (logging, `turnInFlight` clearing) has actually finished (#923).
          await runtimeSession.abort().catch(() => {});
          await inFlightTurn.catch(() => {});
        }
        noteSessionClosed();
        await runtimeSession.disconnect().catch(() => {});
      }
    });
  }

  async function performDispose(): Promise<void> {
    cancelIdleTimer();
    const previous = warmState;
    warmState = { kind: "disposed" };

    if (previous.kind === "ready") {
      const startedAt = now();
      const errors = await safeStop(previous.runtime.client);
      log({
        durationMs: now() - startedAt,
        event: "runtime_stop",
        status: errors.length === 0 ? "ok" : "agent_transport_failed"
      });
      return;
    }
    if (previous.kind === "starting") {
      const runtime = await previous.pending.catch(() => undefined);
      if (runtime !== undefined) {
        const startedAt = now();
        const errors = await safeStop(runtime.client);
        log({
          durationMs: now() - startedAt,
          event: "runtime_stop",
          status: errors.length === 0 ? "ok" : "agent_transport_failed"
        });
      }
      return;
    }
    if (previous.kind === "stopping") {
      // A stop is already in flight (idle release or invalidation) for the runtime this dispose() call
      // wants to stop: await that SAME completion instead of starting a second, redundant stop - and
      // because `warmState` is already "disposed" by the time it settles, that stop's own completion
      // handler correctly leaves it disposed rather than resurrecting it to "cold" (see `beginStop`).
      await previous.pending;
      return;
    }
    // "cold" or already "disposed": nothing live to stop.
  }

  function dispose(): Promise<void> {
    // Idempotent: every caller - however many times dispose() is invoked - awaits the exact same
    // shutdown completion, never a second independent one racing (or redundantly repeating) the first
    // (#923).
    disposePromise ??= performDispose();
    return disposePromise;
  }

  return Object.freeze({ agent: Object.freeze({ open }), dispose });
}

// ---------------------------------------------------------------------------------------------------
// Real-SDK-shaped mapping, fully unit tested against fakes shaped like the installed SDK's own
// `session.d.ts`/`client.d.ts` contracts (never against an invented interface that hides real
// behavior). This is the ONLY place the SDK's actual quirks are handled: `session.sendAndWait`'s own
// `timeout` parameter only stops *awaiting* and never aborts in-flight work (session.d.ts, dist/
// session.js), and only starts its own internal timer AFTER `send()` itself has already resolved - a
// hang before that point is never bounded by the SDK's own timeout at all. `client.stop()` resolves an
// array of cleanup errors rather than throwing (client.d.ts) - an empty array is the only "clean"
// outcome; anything else must be surfaced, never discarded into an assumed success.
// ---------------------------------------------------------------------------------------------------

// Mirrors the subset of the real `CopilotSession` (session.d.ts) this seam depends on.
export type SdkSessionLike = Readonly<{
  sendAndWait(
    prompt: string,
    timeoutMs: number
  ): Promise<Readonly<{ data: Readonly<{ content: string }> }> | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}>;

// Mirrors the subset of the real `CopilotClient` (client.d.ts) this seam depends on.
export type SdkClientLike = Readonly<{
  start(): Promise<void>;
  stop(): Promise<ReadonlyArray<Error>>;
  forceStop(): Promise<void>;
  listModels(): Promise<
    ReadonlyArray<
      Readonly<{ id: string; supportedReasoningEfforts?: ReadonlyArray<ReasoningEffort> }>
    >
  >;
  createSession(sessionConfig: SessionConfig): Promise<SdkSessionLike>;
}>;

// The SDK exports no typed timeout-specific error class (verified against the installed SDK, #923), so
// a thrown timeout is still recognized by this message-content heuristic - but ONLY as a fallback for
// the case where the SDK's own internal, non-cancelling timeout (session.js) happens to reject before
// this seam's OWN owned deadline (below) fires. It is never the only mechanism a real timeout is
// caught by, and either path always calls `abort()` before reporting a timeout.
function isSdkTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timeout|timed out/i.test(error.message);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

// Maps the real SDK session onto this seam's own `CopilotRuntimeSession` contract, owning the
// wall-clock deadline itself instead of trusting the SDK's own non-cancelling `timeout` parameter. On
// ANY timeout outcome - whether this seam's own race fires, or the SDK's internal
// "Timeout after ... waiting for session.idle" rejection wins first - this always calls the SDK's own
// `session.abort()` before reporting the turn as timed out, so a slow/stuck turn actually stops
// generating (and billing) instead of merely being ignored while it keeps running server-side (#923).
export function mapSdkSession(sdkSession: SdkSessionLike): CopilotRuntimeSession {
  return {
    async abort() {
      await sdkSession.abort();
    },
    async disconnect() {
      await sdkSession.disconnect();
    },
    async sendAndWait(prompt, timeoutMs) {
      let timerHandle: ReturnType<typeof setTimeout> | undefined;
      const ownedTimeout = new Promise<"owned-timeout">((resolve) => {
        timerHandle = setTimeout(() => resolve("owned-timeout"), timeoutMs);
      });
      // Bounds BOTH the initial send acknowledgement and the wait-for-idle that follows it, as one
      // owned deadline covering the whole call - not only the waiting phase the SDK's own `timeout`
      // parameter bounds internally.
      const work = sdkSession.sendAndWait(prompt, timeoutMs).then(
        (event) => ({ event, kind: "resolved" as const }),
        (error: unknown) => ({ error, kind: "rejected" as const })
      );
      try {
        const raced = await Promise.race([work, ownedTimeout]);
        const timedOut =
          raced === "owned-timeout" ||
          (raced.kind === "rejected" && isSdkTimeoutError(raced.error));
        if (timedOut) {
          await sdkSession.abort().catch(() => {});
          return { kind: "timeout" };
        }
        if (raced.kind === "rejected") {
          return { kind: "failed", message: describeError(raced.error) };
        }
        if (raced.event === undefined) {
          return {
            kind: "failed",
            message: "the Copilot runtime reported no assistant message for this turn"
          };
        }
        return { content: raced.event.data.content, kind: "ok" };
      } finally {
        clearTimeout(timerHandle);
      }
    }
  };
}

// `stop()` itself reporting (or throwing) a failure falls back to the SDK's own documented remedy,
// `forceStop()` (client.d.ts: "Use this when stop fails or takes too long"), bounded so a stuck
// forceStop can never hang this seam's own shutdown/idle-release/invalidation forever. The original
// `stop()` failure is always preserved in the returned array; a forceStop failure is appended, never
// swallowed - this never reports a clean shutdown that did not actually happen.
async function stopSdkClientWithFallback(
  sdkClient: SdkClientLike,
  forceStopTimeoutMs: number
): Promise<ReadonlyArray<string>> {
  let errors: ReadonlyArray<string>;
  try {
    errors = (await sdkClient.stop()).map((error) => describeError(error));
  } catch (rawError) {
    errors = [describeError(rawError)];
  }
  if (errors.length === 0) {
    return errors;
  }
  try {
    await withTimeout(sdkClient.forceStop(), forceStopTimeoutMs, "forceStop");
    return errors;
  } catch (forceStopError) {
    return [...errors, `forceStop fallback also failed: ${describeError(forceStopError)}`];
  }
}

// Maps a real (or real-shaped fake) SDK client onto this seam's own `CopilotRuntimeClient` contract.
// Fully unit tested - every branch here (stop() error surfacing, the bounded forceStop fallback, model
// metadata projection) is ordinary logic, not I/O, and is exercised directly against `SdkClientLike`/
// `SdkSessionLike` fakes shaped like the installed SDK's own real contracts.
export function mapSdkClient(
  sdkClient: SdkClientLike,
  config: CopilotSdkConfig,
  forceStopTimeoutMs = defaultForceStopTimeoutMs
): CopilotRuntimeClient {
  return {
    async createSession(sessionConfig) {
      const sdkSession = await sdkClient.createSession(
        buildCopilotSessionConfig(config, sessionConfig)
      );
      return mapSdkSession(sdkSession);
    },
    async listModels() {
      const models = await sdkClient.listModels();
      return models.map((model) =>
        model.supportedReasoningEfforts === undefined
          ? { id: model.id }
          : { id: model.id, supportedReasoningEfforts: model.supportedReasoningEfforts }
      );
    },
    start: () => sdkClient.start(),
    stop: () => stopSdkClientWithFallback(sdkClient, forceStopTimeoutMs)
  };
}

/* v8 ignore start -- constructs the real, live Copilot SDK client and spawns its runtime process; this
   is the one line here that cannot be exercised without a real Copilot CLI process. Every mapping,
   timeout/abort, and error-surfacing behavior lives in `mapSdkClient`/`mapSdkSession` above, which are
   fully unit tested against fakes shaped like the installed SDK's own session.d.ts/client.d.ts
   contracts; only the bounded live smoke (docs/AGENT.md) ever exercises this constructor for real. */
function createRealCopilotRuntimeClient(config: CopilotSdkConfig): CopilotRuntimeClient {
  const client = new CopilotClient(buildCopilotClientOptions(config));
  return mapSdkClient(client, config);
}
/* v8 ignore stop */
