import { coachTiers, createRoutedCoach, defaultCostRouting } from "./coachRouter.js";
import type { CoachCallType, CoachTier, CostRouting } from "./coachRouter.js";
import type { CoachProvider } from "./coachProvider.js";

// The coach config seam: which model tier each call type uses, and whether real-model credentials are
// present. Reading is absent-config-safe — with no env it yields the default routing and no key, so
// the server stays on the deterministic fake (the keyless dev mode), exactly like the deploy/web-dir
// guard skips cleanly when unconfigured.
export type CoachConfig = Readonly<{
  apiKey: string | undefined;
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

export function readCoachConfig(env: NodeJS.ProcessEnv = process.env): CoachConfig {
  const routing: CostRouting = {
    analyze: parseTier(env.COACH_ANALYZE_TIER, defaultCostRouting.analyze, tierEnvVar.analyze),
    author: parseTier(env.COACH_AUTHOR_TIER, defaultCostRouting.author, tierEnvVar.author),
    converse: parseTier(env.COACH_CONVERSE_TIER, defaultCostRouting.converse, tierEnvVar.converse),
    judge: parseTier(env.COACH_JUDGE_TIER, defaultCostRouting.judge, tierEnvVar.judge),
    propose: parseTier(env.COACH_PROPOSE_TIER, defaultCostRouting.propose, tierEnvVar.propose)
  };

  return { apiKey: parseApiKey(env.COACH_API_KEY), routing };
}

// The real, cost-routed tiers, built only when credentials are present.
export type CoachAdapters = Readonly<{ cheap: CoachProvider; strong: CoachProvider }>;

export type ResolveCoachDependencies = Readonly<{
  config: CoachConfig;
  // Builds the real tiered adapters from a key. Absent = no real adapter wired yet.
  createAdapters?: (apiKey: string) => CoachAdapters;
  fake: CoachProvider;
}>;

// Resolve the coach to use: the cost-routed real adapters when both a key and an adapter factory are
// present, otherwise the deterministic fake. No key, or no wired adapter, both fall back to the fake —
// the loop never depends on a real model being configured.
export function resolveCoach(dependencies: ResolveCoachDependencies): CoachProvider {
  if (dependencies.config.apiKey === undefined || dependencies.createAdapters === undefined) {
    return dependencies.fake;
  }

  const adapters = dependencies.createAdapters(dependencies.config.apiKey);
  return createRoutedCoach({
    cheap: adapters.cheap,
    routing: dependencies.config.routing,
    strong: adapters.strong
  });
}
