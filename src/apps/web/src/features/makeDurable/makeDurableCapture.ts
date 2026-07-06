// Browser audio boundary for voice Quick Capture (#455): the single impure adapter that turns the
// existing live-capture seam (`createLiveCapture`, the same Web Audio/MediaRecorder path the practice
// call and the tap-and-talk diary use) into Make Durable's one-shot record/stop shape. It touches
// MediaRecorder/getUserMedia, which jsdom does not provide, so — like `features/diary/diaryCapture.ts`
// and `features/session/liveCapture.ts` — it is excluded from coverage in vitest.config.ts. No STT,
// tidy, or persistence lives here: `stop()` just resolves the captured blob, which `MakeDurableSection`
// hands to the existing `transcribe()` seam before submitting the transcript as a voice capture.

import { createLiveCapture, isVoiceCaptureSupported } from "../session/liveCapture.js";
import type { QuickCaptureVoiceDependencies, VoiceRecording } from "./MakeDurableSection.js";

export function createQuickCaptureVoice(): QuickCaptureVoiceDependencies {
  return {
    start: async (): Promise<VoiceRecording> => {
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
