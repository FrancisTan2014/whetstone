import type { LocalSpeechConfig } from "./localSpeechInput.js";
import type { SpeechInput } from "./speechInput.js";
import type { WhisperConfig } from "./whisperSpeechInput.js";

// The voice-input config seam (#799): which local speech provider is configured, if any. Two env pairs
// are recognized. The provider-neutral pair (LOCAL_ASR_BINARY + LOCAL_ASR_MODEL) is the stable boundary;
// the legacy Whisper pair (WHISPER_BINARY + WHISPER_MODEL_PATH) is kept working only as a fallback while
// installations migrate. Resolution names no provider outward beyond this seam - Diary, its worker, and
// database rows carry no provider/model discriminator.

// A resolved provider: the new provider-neutral local ASR (authoritative), or the legacy Whisper adapter
// kept alive through the migration. Which one is chosen never leaks past `resolveSpeechInput`.
export type SpeechProvider =
  | Readonly<{ kind: "local"; local: LocalSpeechConfig }>
  | Readonly<{ kind: "whisper"; whisper: WhisperConfig }>;

export type SpeechConfig = Readonly<{
  // The configured provider, or undefined when nothing is set (fall back to the deterministic fake).
  provider: SpeechProvider | undefined;
  // True when the new pair is authoritative *and* a legacy WHISPER_* key is also present. Resolution
  // ignores the legacy keys in that case; this flag lets setup/doctor surface the leftover so the
  // migration is visible and the operator can remove it.
  legacyAlsoPresent: boolean;
}>;

// A partial new pair (exactly one of LOCAL_ASR_BINARY / LOCAL_ASR_MODEL) is a real misconfiguration, not
// a reason to silently drop to the fake provider. It is reported with the exact remedy.
export type SpeechConfigError = Readonly<{
  message: string;
  remedy: string;
}>;

export type SpeechConfigResult =
  | Readonly<{ ok: true; config: SpeechConfig }>
  | Readonly<{ ok: false; error: SpeechConfigError }>;

function trimmedOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

const PARTIAL_LOCAL_REMEDY =
  "Set both LOCAL_ASR_BINARY (the local speech executable) and LOCAL_ASR_MODEL (its model identifier), or unset both to fall back. See docs/SPEECH.md, or run: pnpm setup:voice";

// Resolve the speech config from env (#799). The provider-neutral pair is authoritative: when both
// LOCAL_ASR_BINARY and LOCAL_ASR_MODEL are present it wins, even if legacy WHISPER_* is also set (flagged
// via `legacyAlsoPresent` for migration visibility). Exactly one new key is an explicit configuration
// error. Only when *neither* new key is present does the complete legacy WHISPER_* pair act as a
// fallback; anything less leaves `provider` undefined so resolution stays on the deterministic fake.
export function readSpeechConfig(env: NodeJS.ProcessEnv = process.env): SpeechConfigResult {
  const localBinary = trimmedOrUndefined(env.LOCAL_ASR_BINARY);
  const localModel = trimmedOrUndefined(env.LOCAL_ASR_MODEL);
  const whisperBinary = trimmedOrUndefined(env.WHISPER_BINARY);
  const whisperModel = trimmedOrUndefined(env.WHISPER_MODEL_PATH);

  const anyLegacy = whisperBinary !== undefined || whisperModel !== undefined;

  if (localBinary !== undefined && localModel !== undefined) {
    return {
      ok: true,
      config: {
        provider: {
          kind: "local",
          local: { binaryPath: localBinary, modelIdentifier: localModel }
        },
        legacyAlsoPresent: anyLegacy
      }
    };
  }

  if (localBinary !== undefined || localModel !== undefined) {
    return {
      ok: false,
      error: {
        message:
          "Local speech is partially configured: exactly one of LOCAL_ASR_BINARY / LOCAL_ASR_MODEL is set.",
        remedy: PARTIAL_LOCAL_REMEDY
      }
    };
  }

  if (whisperBinary !== undefined && whisperModel !== undefined) {
    return {
      ok: true,
      config: {
        provider: {
          kind: "whisper",
          whisper: { binaryPath: whisperBinary, modelPath: whisperModel }
        },
        legacyAlsoPresent: false
      }
    };
  }

  return { ok: true, config: { provider: undefined, legacyAlsoPresent: false } };
}

export type ResolveSpeechInputDependencies = Readonly<{
  config: SpeechConfig;
  // Builds the provider-neutral adapter. Absent = not wired yet (stay on the fake).
  createLocal?: (config: LocalSpeechConfig) => SpeechInput;
  // Builds the legacy Whisper adapter. Absent = not wired yet (stay on the fake).
  createWhisper?: (config: WhisperConfig) => SpeechInput;
  fake: SpeechInput;
}>;

// Resolve the SpeechInput to use: the configured provider's adapter when both a provider config and its
// factory are present, otherwise the deterministic fake. Missing provider or an unwired factory both fall
// back to the fake - the loop never depends on a microphone or a model being installed.
export function resolveSpeechInput(dependencies: ResolveSpeechInputDependencies): SpeechInput {
  const { provider } = dependencies.config;
  if (provider === undefined) {
    return dependencies.fake;
  }
  if (provider.kind === "local") {
    return dependencies.createLocal === undefined
      ? dependencies.fake
      : dependencies.createLocal(provider.local);
  }
  return dependencies.createWhisper === undefined
    ? dependencies.fake
    : dependencies.createWhisper(provider.whisper);
}
