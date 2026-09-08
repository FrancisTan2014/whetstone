import {
  EXPLAIN_PROMPT_VERSION,
  type ExplainRequest,
  type ExplainResponse
} from "@whetstone/contracts";

import type { Agent } from "../../agent/agentSession.js";
import type { DbClient } from "../../db/dbClient.js";
import {
  buildExplainCacheKey,
  fingerprintExplainContext,
  type ExplainCache,
  type ExplainInFlightCoalescer
} from "./explainCache.js";
import {
  buildExplainInstructions,
  buildExplainTurnPayload,
  parseExplainModelOutput
} from "./explainPrompt.js";
import {
  resolveExplainSource,
  type ExplainSelectionRequest,
  type ExplainSourceOutcome
} from "./explainSourceResolution.js";
import {
  runExplainTurn,
  type ExplainTurnLogger,
  type ExplainTurnScheduler
} from "./explainTurn.js";

// The orchestration command for the semantic-map explanation capability (#924): resolve the canonical
// selection server-side, check the bounded successful-answer cache, coalesce concurrent identical
// requests behind ONE Copilot turn, run that turn under its owned whole-request deadline, and validate
// the model's answer against the shared contract before ever returning it. Every branch returns the
// named `ExplainResponse` the route serves verbatim; nothing here throws for an expected outcome.

export type ExplainCachedAnswer = Readonly<{
  provider: Extract<ExplainResponse, { status: "ok" }>["provider"];
  result: Extract<ExplainResponse, { status: "ok" }>["result"];
}>;

// This owned deadline bounds the WHOLE request (`agent.open()` + `session.send()` + the final
// `session.close()`, `explainTurn.ts`), so it must comfortably EXCEED the warm Copilot runtime's own
// internal per-turn bound (120s, `copilotSdkAgent.ts`'s `defaultTurnTimeoutMs`) plus session-open
// overhead — otherwise this seam's own timeout would always fire first and mask a legitimate answer as
// a false "timeout". A real high-reasoning-effort turn was observed taking 40-70s end to end; 150s
// leaves real margin above the runtime's own 120s bound rather than merely matching it.
const defaultExplainTurnTimeoutMs = 150_000;

// The stable standing instructions (persona/rules/JSON shape) never depend on any per-request value —
// built once per process, not re-built on every request, and wired into `Agent.open({ instructions })`
// (`explainTurn.ts`) so the SDK's default coding persona is replaced for the whole session (#923).
const explainInstructions = buildExplainInstructions();

export type ExplainLogRecord = Readonly<{ durationMs: number; status: ExplainResponse["status"] }>;
export type ExplainLogger = (record: ExplainLogRecord) => void;

export type ExplainCommandDependencies = Readonly<{
  // Undefined when the capability is opted out (default-off): the command returns "disabled" before
  // touching the database, the cache, or any turn at all.
  agent?: Agent;
  cache: ExplainCache<ExplainCachedAnswer>;
  coalescer: ExplainInFlightCoalescer<ExplainResponse>;
  db: DbClient;
  log?: ExplainLogger;
  model: string;
  now?: () => number;
  reasoningEffort: string;
  // Injectable so orchestration (cache/dedup/turn-outcome mapping) is unit-tested against a fake
  // resolver, independent of the real PostgreSQL-backed resolution's own dedicated tests
  // (`explainSourceResolution.test.ts`). Defaults to the real, canonical resolver.
  resolveSource?: (db: DbClient, request: ExplainSelectionRequest) => Promise<ExplainSourceOutcome>;
  scheduler?: ExplainTurnScheduler;
  // Structured, content-free session-close cleanup diagnostics (`explainTurn.ts`) — distinct from the
  // outer per-request `log` above, which only ever sees the final response status.
  turnLog?: ExplainTurnLogger;
  turnTimeoutMs?: number;
}>;

export async function explainSelection(
  dependencies: ExplainCommandDependencies,
  request: ExplainRequest
): Promise<ExplainResponse> {
  const { agent } = dependencies;
  if (agent === undefined) {
    return { status: "disabled" };
  }

  const resolveSource = dependencies.resolveSource ?? resolveExplainSource;
  const sourceOutcome = await resolveSource(dependencies.db, request);
  if (sourceOutcome.status !== "ok") {
    return { status: sourceOutcome.status };
  }
  const { source } = sourceOutcome;

  const cacheKey = buildExplainCacheKey({
    blockEntryId: request.blockEntryId,
    contentRevision: source.contentRevision,
    // Folds in the ACTUAL resolved, bounded context (via its fingerprint) — not merely
    // `contentRevision` — so a race between the concurrent block/workMeta reads in
    // `explainSourceResolution.ts` (which can pair an old block snapshot with a newer revision, or vice
    // versa) can never make two genuinely different resolved contexts share a cache key, and a real
    // context change can never be missed just because `contentRevision` alone did not change.
    contextFingerprint: fingerprintExplainContext(source.context),
    endOffset: request.endOffset,
    headword: source.headword,
    language: source.language,
    model: dependencies.model,
    promptVersion: EXPLAIN_PROMPT_VERSION,
    reasoningEffort: dependencies.reasoningEffort,
    startOffset: request.startOffset,
    workEntryId: request.workEntryId
  });

  const cached = dependencies.cache.get(cacheKey);
  if (cached !== undefined) {
    return { provider: cached.provider, result: cached.result, status: "ok" };
  }

  const now = dependencies.now ?? Date.now;
  const log = dependencies.log ?? (() => {});
  const turnLog = dependencies.turnLog ?? (() => {});
  const turnTimeoutMs = dependencies.turnTimeoutMs ?? defaultExplainTurnTimeoutMs;

  const response = await dependencies.coalescer.run(cacheKey, async () => {
    const startedAt = now();
    // Only the per-request DATA is sent as the turn — a single JSON object, never prose concatenation
    // with the headword spliced into quotes. The stable persona/rules/schema live in `sessionConfig.
    // instructions` below instead of being re-sent with every turn.
    const prompt = buildExplainTurnPayload({
      context: source.context,
      headword: source.headword,
      language: source.language
    });

    const turnOutcome = await runExplainTurn({
      agent,
      log: turnLog,
      now,
      prompt,
      // A brand-new session (and therefore a brand-new SDK conversation/history) for every independent
      // explanation, per #923/#924's design: the warm runtime process is reused, a conversation never
      // is. The stable standing instructions replace the SDK's default coding persona for this session
      // (#923's `systemMessage: { mode: "replace", ... }` wiring).
      ...(dependencies.scheduler === undefined ? {} : { scheduler: dependencies.scheduler }),
      sessionConfig: { instructions: explainInstructions },
      timeoutMs: turnTimeoutMs
    });

    const outcome = toExplainResponse(turnOutcome, source.language);
    log({ durationMs: now() - startedAt, status: outcome.status });
    return outcome;
  });

  if (response.status === "ok") {
    dependencies.cache.set(cacheKey, { provider: response.provider, result: response.result });
  }

  return response;
}

function toExplainResponse(
  turnOutcome: Awaited<ReturnType<typeof runExplainTurn>>,
  language: string
): ExplainResponse {
  if (turnOutcome.kind === "timeout") {
    return { status: "timeout" };
  }
  if (turnOutcome.kind === "failed") {
    return { reason: turnOutcome.code, status: "unavailable" };
  }

  const result = parseExplainModelOutput(turnOutcome.turn.text);
  if (result === undefined) {
    return { status: "invalid_response" };
  }
  // The model is instructed to answer in the resolved Work's language; a response tagged with the
  // other one is shape-valid JSON but not an honest answer to THIS request, so it is rejected the same
  // way any other invalid output is — never served under a mismatched label.
  if (result.language !== language) {
    return { status: "invalid_response" };
  }

  return {
    provider: {
      ...(turnOutcome.turn.model === undefined ? {} : { model: turnOutcome.turn.model }),
      ...(turnOutcome.turn.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: turnOutcome.turn.reasoningEffort })
    },
    result,
    status: "ok"
  };
}
