// Browser audio boundary for the tap-and-talk diary (#246): the single impure adapter that turns the
// existing live-capture seam (`createLiveCapture`, the same Web Audio/MediaRecorder path the practice
// call uses) into the diary's one-shot record/stop shape. It touches MediaRecorder/getUserMedia (through
// `createLiveCapture`), which jsdom does not provide, so — like `features/session/liveCapture.ts` — it is
// excluded from coverage in vitest.config.ts. No STT, tidy, or persistence lives here: `stop()` resolves
// the captured blob, which `DiaryPage` hands to the existing `transcribe()` seam.
//
// No-dead-end guarantee (#467): the endpointer only emits `onUtterance` for a *confirmed* utterance, and
// `finishUtterance()` is a no-op until then. So on a real no-speech / too-brief / VAD-never-confirms path
// (Tap to talk → say nothing → Stop & save), waiting on `onUtterance` would hang forever, never release
// the mic, and leave the diary stuck in "transcribing" (typed fallback disabled). This adapter tracks
// whether an utterance was confirmed (`onUtteranceStart`/`onBargeIn`): only then does `stop()` await the
// finalized audio; otherwise it releases the mic and settles with empty audio so `DiaryPage` can take the
// calm no-speech retry instead of hanging.

import { createLiveCapture, isVoiceCaptureSupported } from "../session/liveCapture.js";
import type { LiveCapture, LiveCaptureCallbacks } from "../session/liveCapture.js";
import type { DiaryCaptureDependencies, DiaryRecording } from "./DiaryPage.js";

// The live-capture factory, injected so the one-shot orchestration (including the no-utterance path) is
// testable with a deterministic fake instead of a real microphone.
export type CreateLiveCapture = (callbacks: LiveCaptureCallbacks) => LiveCapture;

export function createDiaryCapture(
  createCapture: CreateLiveCapture = createLiveCapture
): DiaryCaptureDependencies {
  return {
    start: async (): Promise<DiaryRecording> => {
      let confirmed = false;
      let resolveUtterance: (audio: Blob) => void = () => {};
      const utterance = new Promise<Blob>((resolve) => {
        resolveUtterance = resolve;
      });
      const capture = createCapture({
        onBargeIn: () => {
          confirmed = true;
        },
        onUtterance: (audio) => resolveUtterance(audio),
        onUtteranceStart: () => {
          confirmed = true;
        }
      });
      await capture.start();

      return {
        stop: async (): Promise<Blob> => {
          capture.finishUtterance();
          if (!confirmed) {
            // No confirmed utterance: `finishUtterance()` emitted nothing, so `onUtterance` will never
            // fire. Release the mic and settle empty so the caller never hangs in "transcribing".
            capture.stop();
            resolveUtterance(new Blob());
            return utterance;
          }
          // A confirmed utterance is being finalized; `onUtterance` resolves with its captured audio.
          const audio = await utterance;
          capture.stop();
          return audio;
        }
      };
    },
    supported: isVoiceCaptureSupported()
  };
}
