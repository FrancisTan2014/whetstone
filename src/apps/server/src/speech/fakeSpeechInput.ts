import type { Transcription } from "@whetstone/contracts";

import type { SpeechAudio, SpeechInput } from "./speechInput.js";

// A deterministic SpeechInput with no model and no mic, so the whole practice loop tests headlessly
// (the `pnpm validate` gate has no microphone). The caller injects the transcript + timings to
// return — either a fixed transcription, or a function of the audio for per-input scripting. The
// detected `language` is optional here and defaults to null (no detection), since most callers only
// script the transcript; pass it explicitly to simulate Whisper's auto-detected language (#647).
type ScriptedResult = Omit<Transcription, "language"> & Readonly<{ language?: string | null }>;
export type ScriptedTranscription = ScriptedResult | ((audio: SpeechAudio) => ScriptedResult);

function withLanguage(result: ScriptedResult): Transcription {
  return { language: result.language ?? null, transcript: result.transcript, words: result.words };
}

export function createFakeSpeechInput(scripted: ScriptedTranscription): SpeechInput {
  return Object.freeze({
    transcribe(audio: SpeechAudio): Promise<Transcription> {
      return Promise.resolve(
        withLanguage(typeof scripted === "function" ? scripted(audio) : scripted)
      );
    }
  });
}
