// Browser text-to-speech wrapper for the live call loop (#221), with the speech-synthesis API injected
// so the logic is testable under jsdom (which implements neither `speechSynthesis` nor
// `SpeechSynthesisUtterance`). The thin real wiring lives in `browserVoiceOut.ts`; everything here —
// voice selection, async voice load, speak/cancel — is exercised with fakes. Voice OUT only; the neural
// voice seam is later, and the browser `SpeechRecognition` is deliberately not used (STT is the server
// Whisper seam #207).

// The minimal slice of the Web Speech `SpeechSynthesis` API this wrapper needs. Narrower than the DOM
// type so a fake satisfies it; the real `window.speechSynthesis` is cast to it in `browserVoiceOut.ts`.
export interface SpeechSynthesisLike {
  getVoices(): ReadonlyArray<SpeechSynthesisVoice>;
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
  addEventListener(type: "voiceschanged", listener: () => void): void;
}

export type UtteranceFactory = (text: string) => SpeechSynthesisUtterance;

export type VoiceOut = Readonly<{
  // Speak `text`, resolving when playback finishes (or is cancelled/errors). The loop awaits this so it
  // returns to listening only after the coach's turn is spoken.
  speak: (text: string) => Promise<void>;
  // Interrupt any current playback immediately — used for barge-in.
  cancel: () => void;
}>;

// Choose a sensible default English voice: prefer the platform default among English voices, then a
// generic en-US, then any English voice; `undefined` when none are English (the browser then uses its
// own default). Pure, so it is unit-tested directly.
export function pickEnglishVoice(
  voices: ReadonlyArray<SpeechSynthesisVoice>
): SpeechSynthesisVoice | undefined {
  const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith("en"));
  return (
    english.find((voice) => voice.default) ??
    english.find((voice) => voice.lang.toLowerCase() === "en-us") ??
    english[0]
  );
}

export function createVoiceOut(
  synthesis: SpeechSynthesisLike,
  makeUtterance: UtteranceFactory
): VoiceOut {
  // Voices can load asynchronously; cache the pick and refresh it when the browser fires voiceschanged.
  let voice = pickEnglishVoice(synthesis.getVoices());
  synthesis.addEventListener("voiceschanged", () => {
    voice = pickEnglishVoice(synthesis.getVoices());
  });

  return {
    cancel: () => {
      synthesis.cancel();
    },
    speak: (text) =>
      new Promise<void>((resolve) => {
        const utterance = makeUtterance(text);
        if (voice !== undefined) {
          utterance.voice = voice;
        }
        utterance.onend = () => {
          resolve();
        };
        utterance.onerror = () => {
          resolve();
        };
        synthesis.speak(utterance);
      })
  };
}
