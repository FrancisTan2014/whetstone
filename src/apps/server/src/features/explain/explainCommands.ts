import {
  EXPLAIN_PROMPT_VERSION,
  type ExplainRequest,
  type ExplainResponse
} from "@whetstone/contracts";

import type { Agent } from "../../agent/agentSession.js";
import type { DbClient } from "../../db/dbClient.js";
import {
  buildExplainCacheKey,
  type ExplainCache,
  type ExplainInFlightCoalescer
} from "./explainCache.js";
import { buildExplainPrompt, parseExplainModelOutput } from "./explainPrompt.js";
import {
  resolveExplainSource,
  type ExplainSelectionRequest,
  type ExplainSourceOutcome
} from "./explainSourceResolution.js";
import { runExplainTurn, type ExplainTurnScheduler } from "./explainTurn.js";

// The orchestration command for the semantic-map explanation capability (#924): resolve the canonical
// selection server-side, check the bounded successful-answer cache, coalesce concurrent identical
// requests behind ONE Copilot turn, run that turn under its owned whole-request deadline, and validate
// the model's answer against the shared contract before ever returning it. Every branch returns the
// named `ExplainResponse` the route serves verbatim; nothing here throws for an expected outcome.

export type ExplainCachedAnswer = Readonly<{
  provider: Extract<ExplainResponse, { status: "ok" }>["provider"];
  result: Extract<ExplainResponse, { status: "ok" }>["result"];
}>;

// This owned deadline bounds the WHOLE request (`agent.open()` + `session.send()` together,
// `explainTurn.ts`), so it must comfortably EXCEED the warm Copilot runtime's own internal per-turn
// bound (120s, `copilotSdkAgent.ts`'s `defaultTurnTimeoutMs`) plus session-open overhead — otherwise
// this seam's own timeout would always fire first and mask a legitimate answer as a false "timeout".
// A real high-reasoning-effort turn was observed taking 40-70s end to end; 150s leaves real margin
// above the runtime's own 120s bound rather than merely matching it.
const defaultExplainTurnTimeoutMs = 150_000;

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
  const turnTimeoutMs = dependencies.turnTimeoutMs ?? defaultExplainTurnTimeoutMs;

  const response = await dependencies.coalescer.run(cacheKey, async () => {
    const startedAt = now();
    const prompt = buildExplainPrompt({
      context: source.context,
      headword: source.headword,
      language: source.language
    });

    const turnOutcome = await runExplainTurn({
      agent,
      prompt,
      // A brand-new session (and therefore a brand-new SDK conversation/history) for every independent
      // explanation, per #923/#924's design: the warm runtime process is reused, a conversation never
      // is. No standing `instructions` — the whole persona/rules/shape framing is the one canonical
      // prompt itself, matching the existing prose-only `agentModel.ts` convention.
      ...(dependencies.scheduler === undefined ? {} : { scheduler: dependencies.scheduler }),
      sessionConfig: {},
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
