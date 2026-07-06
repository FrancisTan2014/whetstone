import { describe, expect, it, vi } from "vitest";

import type { LiveCaptureCallbacks } from "../session/liveCapture";
import { createDiaryCapture, type CreateLiveCapture } from "./diaryCapture";

// A deterministic stand-in for the browser live-capture seam: it records the callbacks the adapter
// wires up and exposes spies + triggers so a test can drive the confirmed and no-utterance paths
// without a real microphone (the real MediaRecorder/Web Audio path is not exercisable here).
function fakeLiveCapture() {
  let callbacks: LiveCaptureCallbacks | undefined;
  const start = vi.fn(async () => {});
  const stop = vi.fn();
  const finishUtterance = vi.fn();
  const setCoachPlaying = vi.fn();

  const create: CreateLiveCapture = (received) => {
    callbacks = received;
    return { finishUtterance, setCoachPlaying, start, stop };
  };

  return {
    create,
    finishUtterance,
    stop,
    confirmStart: () => callbacks?.onUtteranceStart?.(),
    emitUtterance: (audio: Blob) => callbacks?.onUtterance(audio)
  };
}

describe("createDiaryCapture", () => {
  it("settles empty and releases the mic when no utterance is ever confirmed", async () => {
    const fake = fakeLiveCapture();
    const recording = await createDiaryCapture(fake.create).start();

    // The real hang risk: tap → say nothing → stop. finishUtterance emits nothing, so this must still
    // resolve (with empty audio) rather than await onUtterance forever.
    const audio = await recording.stop();

    expect(audio.size).toBe(0);
    expect(fake.finishUtterance).toHaveBeenCalledTimes(1);
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("returns the finalized audio when a confirmed utterance ends on stop", async () => {
    const fake = fakeLiveCapture();
    const recording = await createDiaryCapture(fake.create).start();

    fake.confirmStart();
    // A confirmed utterance is finalized by finishUtterance, which the engine turns into onUtterance.
    fake.finishUtterance.mockImplementation(() => fake.emitUtterance(new Blob(["spoken"])));

    const audio = await recording.stop();

    expect(await audio.text()).toBe("spoken");
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("returns audio already delivered when the utterance ended naturally before stop", async () => {
    const fake = fakeLiveCapture();
    const recording = await createDiaryCapture(fake.create).start();

    fake.confirmStart();
    fake.emitUtterance(new Blob(["natural"]));

    const audio = await recording.stop();

    expect(await audio.text()).toBe("natural");
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});
