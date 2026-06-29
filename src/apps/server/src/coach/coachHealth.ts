import type { CoachConfig } from "./coachConfig.js";

// A boot-time report of whether the cheap (local Ollama) tier the coach is routed to is actually
// serving its model. This only *reports*: the coach already composes the LLM tiers over the
// deterministic fake, so a missing model or a downed daemon never crashes the loop — those calls just
// fall back to the fake. The report turns that silent degrade into a clear "pull the model" hint on a
// fresh deploy (#271).
export type CoachHealthStatus = "fake" | "cloud_only" | "local_ready" | "local_unavailable";

export type CoachHealthReport = Readonly<{
  message: string;
  status: CoachHealthStatus;
}>;

export type CoachHealthDependencies = Readonly<{
  config: CoachConfig;
  localModel: string;
  // Probe whether the local Ollama model is pulled and serving. Resolves true/false; a thrown error
  // (the daemon is down) is treated as unavailable so the check never throws on boot.
  probeLocalModel: (model: string) => Promise<boolean>;
}>;

export async function checkCoachHealth(
  dependencies: CoachHealthDependencies
): Promise<CoachHealthReport> {
  const { config, localModel, probeLocalModel } = dependencies;

  // No key: the coach runs entirely on the deterministic fake (the keyless dev/practice path).
  if (config.apiKey === undefined) {
    return {
      message: "COACH_API_KEY unset — coach runs on the deterministic fake.",
      status: "fake"
    };
  }

  // A key is present but nothing is routed to the cheap tier, so no local model is needed.
  if (!Object.values(config.routing).includes("cheap")) {
    return {
      message: "No call routed to the local tier — coach uses the cloud model only.",
      status: "cloud_only"
    };
  }

  const available = await probeLocalModel(localModel).catch(() => false);
  if (available) {
    return {
      message: `Local coach model ${localModel} is serving.`,
      status: "local_ready"
    };
  }

  return {
    message: `Local coach model ${localModel} is unavailable — local-tier calls fall back to the fake. Run: ollama pull ${localModel}`,
    status: "local_unavailable"
  };
}
