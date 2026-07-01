import type { SpeechConfig } from "./speechConfig.js";

// A boot-time report of whether local Whisper STT is actually configured. Like `checkCoachHealth`,
// this only *reports*: `resolveSpeechInput` already falls back to the deterministic fake when no
// Whisper is configured, so a missing model never crashes the loop. Without this, spoken practice
// silently returns an empty transcript with no signal; the warning turns that silent degrade into a
// clear "run `pnpm setup --voice`" hint.
export type SpeechHealthStatus = "fake" | "configured";

export type SpeechHealthReport = Readonly<{
  message: string;
  status: SpeechHealthStatus;
}>;

export type SpeechHealthDependencies = Readonly<{
  config: SpeechConfig;
}>;

export function checkSpeechHealth(dependencies: SpeechHealthDependencies): SpeechHealthReport {
  if (dependencies.config.whisper === undefined) {
    return {
      message:
        "Local Whisper STT is not configured — spoken practice transcribes to empty. Set WHISPER_BINARY + WHISPER_MODEL_PATH, or run: pnpm setup --voice",
      status: "fake"
    };
  }

  return {
    message: "Local Whisper STT is configured — spoken practice transcribes locally.",
    status: "configured"
  };
}
