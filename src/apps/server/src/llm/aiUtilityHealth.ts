// Boot-time health report for an optional local AI utility (#602): diary "tidy" or the Reader
// "AI 解释" gloss. This only *reports*: each utility already degrades safely on its own (diary tidy
// returns the faithful transcript; the explanation aid returns null / "unavailable"), so a missing
// model or a downed Ollama daemon never crashes startup. The report turns that silent degrade into a
// clear "run `pnpm setup:ai`" hint on a fresh deploy, mirroring the coach/speech health reports.

export type AiUtilityHealthStatus = "disabled" | "ready" | "unavailable";

export type AiUtilityHealthReport = Readonly<{
  message: string;
  status: AiUtilityHealthStatus;
}>;

export type AiUtilityHealthDependencies = Readonly<{
  // Human label for the utility, e.g. "Diary tidy" or "AI 解释".
  label: string;
  // The configured local model, or undefined when the utility is off (no env var set).
  modelName: string | undefined;
  // Probe whether the local Ollama model is pulled and serving. A thrown error (daemon down) is
  // treated as unavailable so the check never throws on boot.
  probeModel: (model: string) => Promise<boolean>;
  // The one-command setup that provisions this utility's model, e.g. "pnpm setup:ai".
  setupHint: string;
}>;

export async function checkAiUtilityHealth(
  dependencies: AiUtilityHealthDependencies
): Promise<AiUtilityHealthReport> {
  const { label, modelName, probeModel, setupHint } = dependencies;

  if (modelName === undefined) {
    return {
      message: `${label} is off - no local model configured. Run ${setupHint} to enable it.`,
      status: "disabled"
    };
  }

  const available = await probeModel(modelName).catch(() => false);
  if (available) {
    return {
      message: `${label} model ${modelName} is serving.`,
      status: "ready"
    };
  }

  return {
    message: `${label} model ${modelName} is unavailable - it degrades safely. Run: ollama pull ${modelName} (or ${setupHint}).`,
    status: "unavailable"
  };
}
