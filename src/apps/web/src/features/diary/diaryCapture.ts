// Browser audio boundary for the tap-and-talk diary (#246): the single impure adapter that turns the
// existing live-capture seam (`createLiveCapture`, the same Web Audio/MediaRecorder path the practice
// call uses) into the diary's one-shot record/stop shape. It touches MediaRecorder/getUserMedia, which
// jsdom does not provide, so — like `features/session/liveCapture.ts` — it is excluded from coverage in
// vitest.config.ts. No STT, tidy, or persistence lives here: `stop()` just resolves the captured blob,
// which `DiaryPage` hands to the existing `transcribe()` seam.

import { createLiveCapture, isVoiceCaptureSupported } from "../session/liveCapture.js";
import type { DiaryCaptureDependencies, DiaryRecording } from "./DiaryPage.js";

export function createDiaryCapture(): DiaryCaptureDependencies {
  return {
    start: async (): Promise<DiaryRecording> => {
      let resolveUtterance: (audio: Blob) => void = () => {};
      const utterance = new Promise<Blob>((resolve) => {
        resolveUtterance = resolve;
      });
      const capture = createLiveCapture({ onUtterance: (audio) => resolveUtterance(audio) });
      await capture.start();

      return {
        stop: async (): Promise<Blob> => {
          capture.finishUtterance();
          const audio = await utterance;
          capture.stop();
          return audio;
        }
      };
    },
    supported: isVoiceCaptureSupported()
  };
}
