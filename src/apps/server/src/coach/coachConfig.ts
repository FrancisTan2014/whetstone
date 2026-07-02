import { defaultCheapModel } from "./coachAdapters.js";
import { coachTiers, createRoutedCoach, defaultCostRouting } from "./coachRouter.js";
import type { CoachCallType, CoachTier, CostRouting } from "./coachRouter.js";
import type { CoachProvider } from "./coachProvider.js";

// The coach config seam: which model tier each call type uses, which local model serves the cheap
// (converse) tier, and whether a cloud key is present. Reading is absent-config-safe — with no env it
// yields the default routing, the default local model, and no key. With no key the coach still runs
// its LOCAL cheap tier (falling back to the deterministic fake per call if no Ollama daemon is up);
// only strong-routed calls need a key, and without one they use the fake. `COACH_MODEL` overrides the
// local converse model, so the server serves the exact model `pnpm setup --coach` pulled/verified.
export type CoachConfig = Readonly<{
  apiKey: string | undefined;
  converseModel: string;
  routing: CostRouting;
}>;

const tierSet: ReadonlySet<string> = new Set(coachTiers);

const tierEnvVar: Readonly<Record<CoachCallType, string>> = {
  analyze: "COACH_ANALYZE_TIER",
  author: "COACH_AUTHOR_TIER",
  converse: "COACH_CONVERSE_TIER",
  judge: "COACH_JUDGE_TIER",
  propose: "COACH_PROPOSE_TIER"
};

function parseTier(raw: string | undefined, fallback: CoachTier, envVar: string): CoachTier {
  if (raw === undefined) {
    return fallback;
  }

  if (!tierSet.has(raw)) {
    throw new Error(`${envVar} must be one of: ${coachTiers.join(", ")}.`);
  }

  return raw as CoachTier;
}

function parseApiKey(raw: string | undefined): string | undefined {
  return raw === undefined || raw.trim().length === 0 ? undefined : raw;
}

// The local model that serves the cheap (converse) tier: `COACH_MODEL` when set, else the default.
// A blank value is treated as unset so an empty override cannot select an unpulled empty model name.
function parseConverseModel(raw: string | undefined): string {
  return raw === undefined || raw.trim().length === 0 ? defaultCheapModel : raw.trim();
}

export function readCoachConfig(env: NodeJS.ProcessEnv = process.env): CoachConfig {
  const routing: CostRouting = {
    analyze: parseTier(env.COACH_ANALYZE_TIER, defaultCostRouting.analyze, tierEnvVar.analyze),
    author: parseTier(env.COACH_AUTHOR_TIER, defaultCostRouting.author, tierEnvVar.author),
    converse: parseTier(env.COACH_CONVERSE_TIER, defaultCostRouting.converse, tierEnvVar.converse),
    judge: parseTier(env.COACH_JUDGE_TIER, defaultCostRouting.judge, tierEnvVar.judge),
    propose: parseTier(env.COACH_PROPOSE_TIER, defaultCostRouting.propose, tierEnvVar.propose)
  };

  return {
    apiKey: parseApiKey(env.COACH_API_KEY),
    converseModel: parseConverseModel(env.COACH_MODEL),
    routing
  };
}

// The real, cost-routed tiers. `cheap` is always the local Ollama adapter (needs no key); `strong` is
// the cloud adapter when a key is present, otherwise the deterministic fake.
export type CoachAdapters = Readonly<{ cheap: CoachProvider; strong: CoachProvider }>;

export type ResolveCoachDependencies = Readonly<{
  config: CoachConfig;
  // Builds the tiered adapters. Key-optional: with no key the cheap tier is still the real local
  // adapter and the strong tier is the fake. Absent factory = no real adapter wired yet.
  createAdapters?: (apiKey: string | undefined) => CoachAdapters;
  fake: CoachProvider;
}>;

// Resolve the coach to use. With an adapter factory wired we ALWAYS build the cost-routed adapters —
// even with no key — so cheap-routed calls run on the LOCAL adapter while strong-routed calls with no
// key resolve to the fake (via `createAdapters`). With no factory wired we fall back to the fake. The
// loop never depends on a real model: the local cheap adapter itself degrades to the fake per call.
export function resolveCoach(dependencies: ResolveCoachDependencies): CoachProvider {
  if (dependencies.createAdapters === undefined) {
    return dependencies.fake;
  }

  const adapters = dependencies.createAdapters(dependencies.config.apiKey);
  return createRoutedCoach({
    cheap: adapters.cheap,
    routing: dependencies.config.routing,
    strong: adapters.strong
  });
}
