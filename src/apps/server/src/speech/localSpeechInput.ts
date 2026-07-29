import type { TranscribedWord, Transcription } from "@whetstone/contracts";

import type { SpeechAudio, SpeechInput } from "./speechInput.js";
import { runCommand, type CommandRunner } from "./speechProcess.js";

// The provider-neutral local speech adapter (#799): it runs a configured, offline local ASR executable
// over an audio file and maps its JSON into a Transcription. Its public config is deliberately only an
// executable path + a model identifier — no provider name, model flag, or timing capability leaks out, so
// swapping the underlying engine (whisper.cpp, faster-whisper, a calibrated Qwen provider, ...) cannot
// fork Diary or its worker. Audio never leaves the machine and there is ~zero token cost. The executable
// protocol is documented in `docs/SPEECH.md`. Untrusted process output is validated here, at the
// boundary, before anything is trusted inward.

// The executable protocol version this Whetstone build speaks. The configured binary must answer the
// `--contract-version` probe (see `contractVersionArgs`) with exactly this string, loading no model, so a
// stale or incompatible provider is detectable before any audio is handed to it. Keep in lockstep with
// the setup/doctor contract check (scripts/setup/steps/voice.mjs).
export const LOCAL_SPEECH_CONTRACT_VERSION = "1";

export type LocalSpeechConfig = Readonly<{
  binaryPath: string;
  modelIdentifier: string;
}>;

// The cheap, machine-readable readiness probe: `<binary> --contract-version` returns the protocol version
// JSON and loads no model. Setup/doctor use it to prove a provider is compatible before transcribing.
export function buildContractVersionArgs(): ReadonlyArray<string> {
  return ["--contract-version"];
}

// The CLI arguments for a transcription run: the model identifier, a JSON output request, and the saved
// audio path. This protocol is provider-neutral — it forces no language and requests no engine-specific
// alignment flag, so a provider decides its own detection and whether it emits token timings at all.
export function buildLocalSpeechArgs(
  config: LocalSpeechConfig,
  audioPath: string
): ReadonlyArray<string> {
  return ["--model", config.modelIdentifier, "--output", "json", audioPath];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contractError(): never {
  throw new Error("Local speech output did not match the expected transcript contract.");
}

function toMilliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

// Read one word entry strictly: a record with a string `word` and numeric `start`/`end` (seconds).
// Timings are optional *evidence*, but any timing a provider does supply is strictly validated — a
// malformed or impossible (end-before-start) word can never flow inward and corrupt the timing signal.
// Returns null for a blank word (whitespace-only token), which the caller drops.
function readWord(value: unknown): TranscribedWord | null {
  const record = asRecord(value);
  if (record === undefined) {
    contractError();
  }

  const { end, start, word } = record;
  if (typeof word !== "string") {
    contractError();
  }
  if (typeof start !== "number") {
    contractError();
  }
  if (typeof end !== "number") {
    contractError();
  }

  const text = word.trim();
  const startMs = toMilliseconds(start);
  const endMs = toMilliseconds(end);
  if (endMs < startMs) {
    contractError();
  }

  return text.length === 0 ? null : { end: endMs, start: startMs, text };
}

// Collect the (optional) word timings from a `segments` array. `segments` may be omitted entirely by a
// transcript-first provider with no aligner; a present `segments` must be an array, and a segment's
// `words` may be empty or omitted but, when present, must be an array of strictly valid words.
function readWords(segments: unknown): TranscribedWord[] {
  if (segments === undefined) {
    return [];
  }
  if (!Array.isArray(segments)) {
    contractError();
  }

  const words: TranscribedWord[] = [];
  for (const segment of segments) {
    const segmentRecord = asRecord(segment);
    if (segmentRecord === undefined) {
      contractError();
    }
    const { words: segmentWords } = segmentRecord;
    if (segmentWords === undefined) {
      continue;
    }
    if (!Array.isArray(segmentWords)) {
      contractError();
    }
    for (const rawWord of segmentWords) {
      const word = readWord(rawWord);
      if (word !== null) {
        words.push(word);
      }
    }
  }
  return words;
}

// Parse + validate a local ASR executable's stdout and map it to a Transcription. Transcript text is the
// only required field; the detected `language` is read when the provider reports a string one and is null
// otherwise; token timings are optional evidence — an aligner-less provider produces an empty `words`
// array and its transcript is still valid. Throws a clear error on non-JSON or off-contract output so the
// caller never trusts malformed output.
export function parseLocalSpeechOutput(stdout: string): Transcription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Local speech output was not valid JSON.");
  }

  const root = asRecord(parsed);
  if (root === undefined) {
    contractError();
  }
  if (typeof root.text !== "string") {
    contractError();
  }

  const words = readWords(root.segments);
  const language = typeof root.language === "string" ? root.language : null;
  return { language, transcript: root.text.trim(), words };
}

export type LocalSpeechInputDependencies = Readonly<{
  config: LocalSpeechConfig;
  run?: CommandRunner;
}>;

export function createLocalSpeechInput(dependencies: LocalSpeechInputDependencies): SpeechInput {
  const run = dependencies.run ?? runCommand;

  return Object.freeze({
    async transcribe(audio: SpeechAudio): Promise<Transcription> {
      const stdout = await run(
        dependencies.config.binaryPath,
        buildLocalSpeechArgs(dependencies.config, audio.path)
      );
      return parseLocalSpeechOutput(stdout);
    }
  });
}
