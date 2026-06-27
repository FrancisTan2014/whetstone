import type { SpeechInput } from "./speechInput.js";
import type { WhisperConfig } from "./whisperSpeechInput.js";

// The voice-input config seam: whether a local Whisper is configured, and with what model/runtime.
// Reading is absent-config-safe — with no env, `whisper` is undefined and resolution falls back to the
// deterministic fake (the headless dev/test path), so the server never crashes for a missing model.
export type SpeechConfig = Readonly<{
  whisper: WhisperConfig | undefined;
}>;

const DEFAULT_LANGUAGE = "en";

function trimmedOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

// A local Whisper is configured only when both the binary and the model path are present; either one
// missing leaves `whisper` undefined (fall back to the fake).
export function readSpeechConfig(env: NodeJS.ProcessEnv = process.env): SpeechConfig {
  const binaryPath = trimmedOrUndefined(env.WHISPER_BINARY);
  const modelPath = trimmedOrUndefined(env.WHISPER_MODEL_PATH);

  if (binaryPath === undefined || modelPath === undefined) {
    return { whisper: undefined };
  }

  return {
    whisper: {
      binaryPath,
      language: trimmedOrUndefined(env.WHISPER_LANGUAGE) ?? DEFAULT_LANGUAGE,
      modelPath
    }
  };
}

export type ResolveSpeechInputDependencies = Readonly<{
  config: SpeechConfig;
  // Builds the real adapter from a Whisper config. Absent = no adapter wired yet (stay on the fake).
  createWhisper?: (config: WhisperConfig) => SpeechInput;
  fake: SpeechInput;
}>;

// Resolve the SpeechInput to use: the local Whisper adapter when both a Whisper config and an adapter
// factory are present, otherwise the deterministic fake. Missing model or unwired adapter both fall
// back to the fake — the loop never depends on a microphone or a model being installed.
export function resolveSpeechInput(dependencies: ResolveSpeechInputDependencies): SpeechInput {
  if (dependencies.config.whisper === undefined || dependencies.createWhisper === undefined) {
    return dependencies.fake;
  }

  return dependencies.createWhisper(dependencies.config.whisper);
}
