import type { TranscribedWord, Transcription } from "@whetstone/contracts";

import type { SpeechAudio, SpeechInput } from "./speechInput.js";
import { runCommand, type CommandRunner } from "./whisperProcess.js";

// A local OSS Whisper adapter: it runs a configured, offline Whisper CLI (whisper.cpp / faster-whisper
// or a thin wrapper) over an audio file and maps its word-timestamped JSON into a Transcription. Audio
// never leaves the machine and there is ~zero token cost. The expected stdout contract and the
// model/runtime are documented in `docs/SPEECH.md`. Untrusted process output is validated here, at the
// boundary, before anything is trusted inward.

export type WhisperConfig = Readonly<{
  binaryPath: string;
  // BCP-47-ish language code passed to the model (e.g. "en").
  language: string;
  modelPath: string;
}>;

// The CLI arguments handed to the Whisper binary. The operator points `binaryPath` at a tool/wrapper
// that honours these and emits the documented JSON contract on stdout.
export function buildWhisperArgs(config: WhisperConfig, audioPath: string): ReadonlyArray<string> {
  return [
    "--model",
    config.modelPath,
    "--language",
    config.language,
    "--output",
    "json",
    "--word-timestamps",
    audioPath
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function contractError(): never {
  throw new Error("Whisper output did not match the expected word-timestamp contract.");
}

function toMilliseconds(seconds: number): number {
  return Math.max(0, Math.round(seconds * 1000));
}

// Read one word entry strictly: a record with a string `word` and numeric `start`/`end` (seconds).
// Returns null for a blank word (whisper emits whitespace-only tokens), which the caller drops.
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
  // Reject impossible timings: a word cannot end before it starts. Caught here so an end-before-start
  // word can never flow inward and corrupt the latency / inter-word-pause signal.
  if (endMs < startMs) {
    contractError();
  }

  return text.length === 0 ? null : { end: endMs, start: startMs, text };
}

// Parse + validate the Whisper stdout and map it to a Transcription (seconds -> integer ms; blank
// words dropped). Throws a clear error on non-JSON or off-contract output so the caller never trusts
// malformed process output.
export function parseWhisperOutput(stdout: string): Transcription {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Whisper output was not valid JSON.");
  }

  const root = asRecord(parsed);
  if (root === undefined) {
    contractError();
  }
  if (typeof root.text !== "string") {
    contractError();
  }
  if (!Array.isArray(root.segments)) {
    contractError();
  }

  const words: TranscribedWord[] = [];
  for (const segment of root.segments) {
    const segmentRecord = asRecord(segment);
    if (segmentRecord === undefined) {
      contractError();
    }
    if (!Array.isArray(segmentRecord.words)) {
      contractError();
    }
    for (const rawWord of segmentRecord.words) {
      const word = readWord(rawWord);
      if (word !== null) {
        words.push(word);
      }
    }
  }

  return { transcript: root.text.trim(), words };
}

export type WhisperSpeechInputDependencies = Readonly<{
  config: WhisperConfig;
  run?: CommandRunner;
}>;

export function createWhisperSpeechInput(
  dependencies: WhisperSpeechInputDependencies
): SpeechInput {
  const run = dependencies.run ?? runCommand;

  return Object.freeze({
    async transcribe(audio: SpeechAudio): Promise<Transcription> {
      const stdout = await run(
        dependencies.config.binaryPath,
        buildWhisperArgs(dependencies.config, audio.path)
      );
      return parseWhisperOutput(stdout);
    }
  });
}
