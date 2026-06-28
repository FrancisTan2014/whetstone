// The thin browser wiring for voice-out (#221): the only impure part of the TTS wrapper — it touches
// `window.speechSynthesis` and the `SpeechSynthesisUtterance` constructor, neither of which exists in
// jsdom. All logic lives in `createVoiceOut` (voiceOut.ts), which is fully tested with a fake synth, so
// this file is excluded from coverage (see vitest.config.ts), like the mic-capture boundaries.

import { createVoiceOut, type SpeechSynthesisLike, type VoiceOut } from "./voiceOut.js";

export function createBrowserVoiceOut(): VoiceOut {
  return createVoiceOut(
    window.speechSynthesis as unknown as SpeechSynthesisLike,
    (text) => new SpeechSynthesisUtterance(text)
  );
}
