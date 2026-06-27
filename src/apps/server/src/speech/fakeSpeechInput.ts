import type { Transcription } from "@whetstone/contracts";

import type { SpeechAudio, SpeechInput } from "./speechInput.js";

// A deterministic SpeechInput with no model and no mic, so the whole practice loop tests headlessly
// (the `pnpm validate` gate has no microphone). The caller injects the transcript + timings to
// return — either a fixed transcription, or a function of the audio for per-input scripting.
export type ScriptedTranscription = Transcription | ((audio: SpeechAudio) => Transcription);

export function createFakeSpeechInput(scripted: ScriptedTranscription): SpeechInput {
  return Object.freeze({
    transcribe(audio: SpeechAudio): Promise<Transcription> {
      return Promise.resolve(typeof scripted === "function" ? scripted(audio) : scripted);
    }
  });
}
