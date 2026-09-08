import type { ExplainCapability } from "@whetstone/contracts";

// The semantic-map explanation capability's own opt-in gate (#924). Deliberately independent of BOTH
// the diary/tidy agent config (`AGENT_BINARY`/`AGENT_MODEL`, `agentConfig.ts`) and the legacy Ollama
// "AI 解释" lookup aid (`EXPLAIN_MODEL`, `lookup/explainProvider.ts`): configuring either of those must
// never implicitly turn this on. Default-off, like every optional local AI utility (`PRODUCT.md`
// AI boundary).

export type ExplainFeatureConfig = Readonly<{ enabled: boolean }>;

const truthyValues = new Set(["1", "true"]);

export function readExplainFeatureConfig(
  env: NodeJS.ProcessEnv = process.env
): ExplainFeatureConfig {
  const raw = env.AGENT_COPILOT_EXPLAIN_ENABLED?.trim().toLowerCase();
  return { enabled: raw !== undefined && truthyValues.has(raw) };
}

const disabledRemedy =
  "Set AGENT_COPILOT_EXPLAIN_ENABLED=1 to opt in, and ensure the Copilot CLI this seam spawns is " +
  "authenticated (see docs/AGENT.md). Enabling it does not by itself prove authentication or model " +
  "generation will succeed — that is only known once a real explanation request is made.";

// A truthful, read-only capability report for the Reader (#925): `enabled: true` means opted in AND —
// because the server only reaches this point after `readCopilotSdkConfig` validated successfully at
// boot (an invalid override fails the boot fast, exactly like every other agent config) — configured
// with settings this seam recognizes. It is NOT proof that a real Copilot turn will succeed; only an
// actual POST /api/explain discovers an authentication/runtime failure.
export function resolveExplainCapability(config: ExplainFeatureConfig): ExplainCapability {
  if (!config.enabled) {
    return { enabled: false, reason: "feature_disabled", remedy: disabledRemedy };
  }
  return { enabled: true };
}
