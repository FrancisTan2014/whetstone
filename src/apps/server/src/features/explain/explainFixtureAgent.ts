import type { Agent, AgentSession, AgentTurn } from "../../agent/agentSession.js";
import type { CopilotSdkAgentRuntime } from "../../agent/copilotSdkAgent.js";

// Dev/E2E-only deterministic stand-in for the real warm Copilot SDK runtime (#923), gated by
// AGENT_COPILOT_EXPLAIN_FIXTURE=1 — the same env-gated-fixture convention `serverConfig.ts` already
// uses for `PDF_IMPORT_FIXTURE_CONVERSION`/`VOICE_CAPTURE_FIXTURE_TRANSCRIPT`: CI ships no
// authenticated Copilot CLI, so the Reader's semantic-explanation E2E suite
// (`e2e/tests/semanticLookup.spec.ts`) needs a same-shaped `Agent` that returns CONTRACT-VALID text
// without ever calling a real provider. Never true in production — a real request there always
// reaches the real runtime (`copilotSdkAgent.ts`) or fails visibly. Every canned answer is keyed ONLY
// off the turn's own JSON payload (`headword`/`language`/`context`, exactly what a real model would
// see via `explainPrompt.ts`'s `buildExplainTurnPayload`), never off out-of-band test state, so the
// Reader's real request/response wiring — not a route stub — is exercised end to end.

export type ExplainFixtureConfig = Readonly<{
  enabled: boolean;
  // Overrides the command's owned whole-request deadline (`explainCommands.ts`'s 150s default) so the
  // deterministic "timeout" outcome can be exercised in a normal E2E run instead of a 150s wait. Never
  // set in production (the real deadline stays the calibrated 150s).
  turnTimeoutMs?: number;
}>;

const truthyValues = new Set(["1", "true"]);

// The fixture's own turn-timeout override is meaningless (and must never take effect) unless the
// fixture itself is genuinely engaged (#925 correction): previously this parsing ran unconditionally
// at every server startup, so (a) a stray/malformed value could crash ordinary AI-off startup, and
// (b) a valid-but-stray value (fixture NOT actually enabled) could silently override the real
// production 150s deadline on the REAL Copilot runtime. Both are now impossible: the block below only
// runs at all once `enabled` is true.
const MAX_FIXTURE_TIMEOUT_MS = 150_000;

// A full-string strict positive integer — never `Number.parseInt`, which silently truncates a
// trailing fraction ("3.5" -> 3) or accepts a garbage suffix ("3000junk" -> 3000). Any input that is
// not ENTIRELY digits (no sign, no decimal point, no trailing text) is rejected outright.
const STRICT_POSITIVE_INTEGER = /^[1-9]\d*$/;

export function readExplainFixtureConfig(
  env: NodeJS.ProcessEnv = process.env
): ExplainFixtureConfig {
  const rawEnabled = env.AGENT_COPILOT_EXPLAIN_FIXTURE?.trim().toLowerCase();
  const enabled = rawEnabled !== undefined && truthyValues.has(rawEnabled);

  if (!enabled) {
    // Fixture mode is off: any `AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS` value — valid, malformed, or
    // absent — is irrelevant and must not affect ordinary (real-runtime or AI-off) startup at all.
    return { enabled };
  }

  const rawTimeout = env.AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS?.trim();
  if (rawTimeout === undefined || rawTimeout.length === 0) {
    return { enabled };
  }

  if (!STRICT_POSITIVE_INTEGER.test(rawTimeout)) {
    throw new Error(
      "AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS must be a positive integer (no fraction, sign, or extra characters)."
    );
  }

  const turnTimeoutMs = Number.parseInt(rawTimeout, 10);
  if (turnTimeoutMs > MAX_FIXTURE_TIMEOUT_MS) {
    throw new Error(
      `AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS must be at most ${MAX_FIXTURE_TIMEOUT_MS}.`
    );
  }

  return { enabled, turnTimeoutMs };
}

type FixtureTurnPayload = Readonly<{ context: string; headword: string; language: string }>;

function parseTurnPayload(prompt: string): FixtureTurnPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(prompt);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;
  if (
    typeof record.context !== "string" ||
    typeof record.headword !== "string" ||
    typeof record.language !== "string"
  ) {
    return undefined;
  }

  return { context: record.context, headword: record.headword, language: record.language };
}

const fixtureModel = "fixture-copilot-model";
const fixtureReasoningEffort = "fixture-high";

// A real homograph — two genuinely unrelated etymologies, never one fabricated universal root
// (#925 correction): "riverbank" traces to Old Norse, "financial bank" traces separately to Italian
// "banca". The current family/branch marker is chosen from the REAL resolved context (never
// hardcoded), and covers all four combinations so neither the first family nor the first branch is
// ever silently assumed correct.
function bankResult(headword: string, language: string, context: string) {
  const isFinancial = context.includes("account") || context.includes("bank on");
  const currentFamilyId = isFinancial ? "financial" : "river";
  const currentBranchId = isFinancial
    ? context.includes("bank on")
      ? "deposit"
      : "institution"
    : context.includes("maneuver")
      ? "tilt"
      : "riverside";

  return {
    currentBranchId,
    currentFamilyId,
    etymology:
      'The riverbank sense traces to Old Norse "bakki" (ridge, slope); the financial sense traces ' +
      'separately to Italian "banca" (a moneychanger\'s bench) — two unrelated origins for one ' +
      "modern spelling.",
    families: [
      {
        branches: [
          {
            connection: "the sloping ground itself, at the water's edge",
            example: "They sat on the bank and watched the current.",
            id: "riverside",
            label: "a riverbank or lakeshore"
          },
          {
            connection: "a slope suggests something leaning or tilting sideways",
            example: "The plane banked sharply to the left.",
            id: "tilt",
            label: "to tilt or lean sideways"
          }
        ],
        coreImage: "a sloping earthen edge, as beside a river",
        id: "river"
      },
      {
        branches: [
          {
            connection: "the institution itself, holding money in trust",
            example: "She opened an account at the bank.",
            id: "institution",
            label: "a financial institution"
          },
          {
            connection:
              "trusting an institution to hold something safely extends to relying on anything",
            example: "You can bank on him to arrive early.",
            id: "deposit",
            label: "to rely on"
          }
        ],
        coreImage: "an institution that holds and manages money",
        id: "financial"
      }
    ],
    headword,
    language,
    nuance: "An everyday, neutral word in every sense — no register warning applies.",
    pronunciation: [{ label: "IPA", value: "/b\u00e6\u014bk/" }]
  };
}

// A genuinely monosemous-core Chinese verb with several branches sharing one core (never a second
// invented family), pinyin pronunciation, and a nuance note — but no etymology/usageNote/culturalNote,
// proving those three optional fields render only when present.
function daResult(headword: string, language: string, context: string) {
  const isPhoneCall = context.includes("电话");
  return {
    currentBranchId: isPhoneCall ? "call" : "hit",
    currentFamilyId: "core",
    families: [
      {
        branches: [
          {
            connection: "用手或工具击打某物的字面动作",
            example: "他轻轻打了一下桌子。",
            id: "hit",
            label: "打：击打"
          },
          {
            connection: "从击打引申为发起电话通话",
            example: "我明天给你打电话。",
            id: "call",
            label: "打：打电话"
          },
          {
            connection: "引申为进行需要动手的运动或活动",
            example: "他们周末喜欢打篮球。",
            id: "play",
            label: "打：打球"
          }
        ],
        coreImage: "用手或借助动作对某物施加力量",
        id: "core"
      }
    ],
    headword,
    language,
    nuance: "非常口语化，日常使用频率很高。",
    pronunciation: [{ label: "拼音", value: "dǎ" }]
  };
}

// A minimal, fully-optional-fields-absent answer (no pronunciation/nuance/usageNote/etymology/
// culturalNote, no provider attribution) returned only on the SECOND attempt for the same exact
// prompt — the first attempt always throws a transport failure. This is a deliberately contained,
// dev/E2E-only test double (never production business logic): it lets the E2E suite prove BOTH an
// honest failure/retry state AND that a real retry can recover, and that the UI never fabricates
// attribution or optional fields the response omits.
function recoveredResult(headword: string, language: string) {
  return {
    currentBranchId: "only",
    currentFamilyId: "core",
    families: [
      {
        branches: [
          {
            connection: "the retry succeeded after the first attempt failed",
            example: "This is the recovered explanation.",
            id: "only",
            label: "recovered"
          }
        ],
        coreImage: "a minimal recovered explanation with no optional fields",
        id: "core"
      }
    ],
    headword,
    language
  };
}

export function createExplainFixtureAgent(): Agent {
  // Scoped to this one fixture agent instance (one per server process) — counts attempts per EXACT
  // prompt string so the "breaktransport" magic headword fails once, then recovers, deterministically.
  const transportAttempts = new Map<string, number>();

  return {
    async open() {
      const session: AgentSession = {
        async close() {
          // Nothing to release: the fixture holds no external process/connection.
        },
        async send(prompt: string): Promise<AgentTurn> {
          const payload = parseTurnPayload(prompt);
          if (payload === undefined) {
            // An unrecognized/unparseable turn: answer with harmless invalid JSON rather than
            // guessing, so any unexpected caller sees the same honest `invalid_response` a real
            // malformed model answer would produce.
            return { text: "" };
          }

          const headword = payload.headword.trim().toLowerCase();

          if (headword === "timeouttest") {
            // Never resolves: the caller's own owned deadline (`explainTurn.ts`) is what ends this,
            // proving the "timeout" outcome rather than any fixture-side rejection.
            return new Promise<AgentTurn>(() => {});
          }

          if (headword === "breaktransport") {
            const attempt = (transportAttempts.get(prompt) ?? 0) + 1;
            transportAttempts.set(prompt, attempt);
            if (attempt === 1) {
              throw new Error("fixture: simulated transport failure");
            }
            return { text: JSON.stringify(recoveredResult(payload.headword, payload.language)) };
          }

          if (headword === "badjson") {
            return { text: "this fixture answer is not valid JSON" };
          }

          const result =
            headword === "bank"
              ? bankResult(payload.headword, payload.language, payload.context)
              : daResult(payload.headword, payload.language, payload.context);

          return {
            model: fixtureModel,
            reasoningEffort: fixtureReasoningEffort,
            text: JSON.stringify(result)
          };
        }
      };
      return session;
    }
  };
}

// Wraps the fixture agent in the same `{ agent, dispose }` shape `createCopilotSdkAgentRuntime`
// returns, so `index.ts` can wire either behind the identical `CopilotSdkAgentRuntime | undefined`
// variable with no extra union type. `dispose()` is a no-op: the fixture owns no process/connection.
export function createExplainFixtureRuntime(): CopilotSdkAgentRuntime {
  return { agent: createExplainFixtureAgent(), dispose: async () => {} };
}
