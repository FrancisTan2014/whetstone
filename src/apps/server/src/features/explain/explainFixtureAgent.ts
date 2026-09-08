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

export function readExplainFixtureConfig(
  env: NodeJS.ProcessEnv = process.env
): ExplainFixtureConfig {
  const rawEnabled = env.AGENT_COPILOT_EXPLAIN_FIXTURE?.trim().toLowerCase();
  const enabled = rawEnabled !== undefined && truthyValues.has(rawEnabled);

  const rawTimeout = env.AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS?.trim();
  if (rawTimeout === undefined || rawTimeout.length === 0) {
    return { enabled };
  }

  const turnTimeoutMs = Number.parseInt(rawTimeout, 10);
  if (!Number.isInteger(turnTimeoutMs) || turnTimeoutMs <= 0) {
    throw new Error("AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS must be a positive integer.");
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

// A homograph (two truly unrelated sense families) with multiple branches in the mechanical family,
// full optional pronunciation/nuance/etymology, and a current-family/branch marker chosen from the
// REAL resolved context (never hardcoded) — proves multi-family rendering, multi-branch rendering,
// and the current-passage marker together.
function springResult(headword: string, language: string, context: string) {
  const isDevice = context.includes("coiled");
  return {
    currentBranchId: isDevice ? "device-leap" : "season-arrival",
    currentFamilyId: isDevice ? "device" : "season",
    etymology: 'From Old English "springan", to leap or burst forth.',
    families: [
      {
        branches: [
          {
            connection: "the calendar season itself, when plants and warmth return",
            example: "Spring arrived early this year.",
            id: "season-arrival",
            label: "the season"
          }
        ],
        coreImage: "the season of renewal that follows winter",
        id: "season"
      },
      {
        branches: [
          {
            connection: "a coiled metal part that pushes back when compressed",
            example: "The spring in the old clock finally broke.",
            id: "device-coil",
            label: "mechanical coil"
          },
          {
            connection: "to move suddenly, the way a released coil snaps forward",
            example: "The cat sprang from the shelf.",
            id: "device-leap",
            label: "leap suddenly"
          }
        ],
        coreImage: "a coiled mechanism that stores and releases energy",
        id: "device"
      }
    ],
    headword,
    language,
    nuance: "An everyday, neutral word in every sense — no register warning applies.",
    pronunciation: [{ label: "IPA", value: "/sprɪŋ/" }]
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
            connection: "the literal act of striking something with the hand or a tool",
            example: "他轻轻打了一下桌子。",
            id: "hit",
            label: "打：击打"
          },
          {
            connection: "extended from striking a surface to initiating a call",
            example: "我明天给你打电话。",
            id: "call",
            label: "打：打电话"
          },
          {
            connection: "extended to performing a hands-on sport or activity",
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
            headword === "spring"
              ? springResult(payload.headword, payload.language, payload.context)
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
