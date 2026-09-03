// Boot-time health report for an optional local AI utility (#602): diary "tidy" or the Reader
// "AI 解释" gloss. This only *reports*: each utility already degrades safely on its own (diary tidy
// returns the faithful transcript; the explanation aid returns null / "unavailable"), so a missing
// model or a downed Ollama daemon never crashes startup. The report turns that silent degrade into a
// clear "run `pnpm setup:ai`" hint on a fresh deploy, mirroring the coach/speech health reports.

export type AiUtilityHealthStatus = "disabled" | "ready" | "unavailable";

// Which backend serves the utility. "model" is the local Ollama model named by `modelName` (an unset
// name means that backend is simply off). "agent" is the local agent CLI (#906): diary tidy prefers it
// when `AGENT_BINARY` + `AGENT_MODEL` are set, so the boot line must name the backend actually in use
// instead of reporting a model the utility no longer calls. The Reader gloss is Ollama-only and always
// passes "model".
export type AiUtilityBackend = "agent" | "model";

export type AiUtilityHealthReport = Readonly<{
  message: string;
  status: AiUtilityHealthStatus;
}>;

export type AiUtilityHealthDependencies = Readonly<{
  // The backend this utility resolved to, decided by the utility itself (diary tidy's
  // `selectDiaryTidyBackend`); this report only echoes that decision.
  backend: AiUtilityBackend;
  // Human label for the utility, e.g. "Diary tidy" or "AI 解释".
  label: string;
  // The configured local model, or undefined when the model backend is off (no env var set).
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
  const { backend, label, modelName, probeModel, setupHint } = dependencies;

  // The agent backend is not probed here: it is an external CLI reached one process at a time, and this
  // report must stay cheap and non-blocking at boot. Naming it is what an operator needs — the seam
  // reports every turn's outcome by name in the operational log, and tidy still degrades to the raw
  // transcript if the CLI fails.
  if (backend === "agent") {
    return {
      message: `${label} is using the local agent CLI (AGENT_BINARY) - it takes precedence over any local model. See docs/AGENT.md.`,
      status: "ready"
    };
  }

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
