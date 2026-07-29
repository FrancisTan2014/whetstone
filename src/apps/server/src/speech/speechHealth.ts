import type { SpeechConfig } from "./speechConfig.js";

// A boot-time report of whether local speech-to-text is actually configured, and through which boundary.
// This only *reports*: `resolveSpeechInput` already falls back to the deterministic fake when no provider
// is configured, so a missing model never crashes the loop. Without this, voice diary capture silently
// returns an empty transcript with no signal; the report turns that silent degrade into a clear "run
// `pnpm setup:voice`" hint, and surfaces two migration states (#799): a legacy WHISPER_* install, and a
// mixed config where the new pair is authoritative but stale WHISPER_* keys are still present.
type SpeechHealthStatus = "fake" | "local" | "legacy";

export type SpeechHealthReport = Readonly<{
  message: string;
  status: SpeechHealthStatus;
}>;

export type SpeechHealthDependencies = Readonly<{
  config: SpeechConfig;
}>;

export function checkSpeechHealth(dependencies: SpeechHealthDependencies): SpeechHealthReport {
  const { provider, legacyAlsoPresent } = dependencies.config;

  if (provider === undefined) {
    return {
      message:
        "Local speech-to-text is not configured - voice diary transcribes to empty. Set LOCAL_ASR_BINARY + LOCAL_ASR_MODEL, or run: pnpm setup:voice",
      status: "fake"
    };
  }

  if (provider.kind === "whisper") {
    return {
      message:
        "Local speech-to-text is configured via legacy WHISPER_BINARY + WHISPER_MODEL_PATH - voice diary transcribes locally. Migrate to LOCAL_ASR_BINARY + LOCAL_ASR_MODEL (see docs/SPEECH.md).",
      status: "legacy"
    };
  }

  const migrationHint = legacyAlsoPresent
    ? " Legacy WHISPER_* is also set and ignored; remove it to finish the migration."
    : "";
  return {
    message: `Local speech-to-text is configured via LOCAL_ASR_BINARY + LOCAL_ASR_MODEL - voice diary transcribes locally.${migrationHint}`,
    status: "local"
  };
}
