import { describe, expect, it } from "vitest";

import {
  createEndpointer,
  forceEndUtterance,
  isCapturingUtterance,
  pushFrame,
  type EndpointConfig,
  type EndpointEvent,
  type EndpointerState
} from "./endpointing.js";

// 20ms frames: minSpeech 100ms = 5 voiced frames to confirm a start, endSilence 200ms = 10 silent
// frames to end.
const config: EndpointConfig = {
  endSilenceMs: 200,
  frameMs: 20,
  minSpeechMs: 100,
  noiseFloor: 0.1
};

const VOICED = 1;
const SILENT = 0;

function frames(count: number, energy: number): ReadonlyArray<number> {
  return Array.from({ length: count }, () => energy);
}

function run(
  cfg: EndpointConfig,
  energies: ReadonlyArray<number>
): Readonly<{ events: ReadonlyArray<EndpointEvent>; state: EndpointerState }> {
  let state = createEndpointer(cfg);
  const events: EndpointEvent[] = [];
  for (const energy of energies) {
    const step = pushFrame(state, energy);
    state = step.state;
    if (step.event !== null) {
      events.push(step.event);
    }
  }
  return { events, state };
}

describe("endpointing — utterance start/end with onset candidate", () => {
  it("opens a candidate on the first voiced frame, confirms the start, then ends after silence", () => {
    // 3 leading silent, 8 voiced (candidate at frame 3, start confirmed on the 5th = frame 7),
    // 12 trailing silent (end on the 10th = frame 20).
    const { events } = run(config, [
      ...frames(3, SILENT),
      ...frames(8, VOICED),
      ...frames(12, SILENT)
    ]);

    expect(events).toEqual([
      { frameIndex: 3, type: "speech-candidate" },
      { frameIndex: 7, speechStartFrameIndex: 3, type: "utterance-start" },
      { frameIndex: 20, type: "utterance-end" }
    ]);
  });

  it("does not end on a short intra-sentence pause, only on the long trailing pause", () => {
    const { events } = run(config, [
      ...frames(6, VOICED), // candidate at 0, start confirmed at 4
      ...frames(4, SILENT), // 80ms pause — under the 200ms end window, must NOT end
      ...frames(3, VOICED), // speech resumes, resetting the silence run
      ...frames(12, SILENT) // long pause — ends the utterance
    ]);

    expect(events).toEqual([
      { frameIndex: 0, type: "speech-candidate" },
      { frameIndex: 4, speechStartFrameIndex: 0, type: "utterance-start" },
      { frameIndex: 22, type: "utterance-end" }
    ]);
  });

  it("aborts a candidate that goes silent before the speech window completes", () => {
    // 3 voiced frames (candidate at 0) then silence — never reaches the 5-frame window.
    const { events, state } = run(config, [...frames(3, VOICED), SILENT]);

    expect(events).toEqual([
      { frameIndex: 0, type: "speech-candidate" },
      { frameIndex: 3, type: "speech-aborted" }
    ]);
    expect(isCapturingUtterance(state)).toBe(false);
  });

  it("emits nothing for leading/trailing silence with no speech", () => {
    const { events, state } = run(config, frames(8, SILENT));

    expect(events).toEqual([]);
    expect(isCapturingUtterance(state)).toBe(false);
  });

  it("treats a noisy floor of isolated spikes as repeated aborted candidates, never an utterance", () => {
    // Spikes above the floor but always broken by silence: each spike opens a candidate that the next
    // silent frame aborts, so the voiced run never reaches 5 and no utterance is confirmed.
    const noisy = Array.from({ length: 6 }, (_, index) => (index % 2 === 0 ? 0.2 : 0.05));
    const { events, state } = run(config, noisy);

    expect(events).toEqual([
      { frameIndex: 0, type: "speech-candidate" },
      { frameIndex: 1, type: "speech-aborted" },
      { frameIndex: 2, type: "speech-candidate" },
      { frameIndex: 3, type: "speech-aborted" },
      { frameIndex: 4, type: "speech-candidate" },
      { frameIndex: 5, type: "speech-aborted" }
    ]);
    expect(isCapturingUtterance(state)).toBe(false);
  });

  it("reports capturing state across the utterance lifecycle", () => {
    const started = run(config, frames(5, VOICED)).state;
    expect(isCapturingUtterance(started)).toBe(true);

    const ended = run(config, [...frames(5, VOICED), ...frames(10, SILENT)]).state;
    expect(isCapturingUtterance(ended)).toBe(false);
  });

  it("treats energy exactly at the noise floor as silence (strictly-greater threshold)", () => {
    const { events } = run(config, frames(8, config.noiseFloor));

    expect(events).toEqual([]);
  });

  it("confirms immediately, without a separate candidate, when the speech window is one frame", () => {
    const instant: EndpointConfig = {
      endSilenceMs: 0,
      frameMs: 20,
      minSpeechMs: 0,
      noiseFloor: 0.1
    };

    const { events } = run(instant, [VOICED, SILENT]);

    expect(events).toEqual([
      { frameIndex: 0, speechStartFrameIndex: 0, type: "utterance-start" },
      { frameIndex: 1, type: "utterance-end" }
    ]);
  });
});

describe("endpointing — forceEndUtterance (tap to finish)", () => {
  it("force-ends an in-progress utterance at the current position without consuming a frame", () => {
    const speaking = run(config, [...frames(3, SILENT), ...frames(8, VOICED)]).state;

    const step = forceEndUtterance(speaking);

    expect(step.event).toEqual({ frameIndex: 11, type: "utterance-end" });
    expect(isCapturingUtterance(step.state)).toBe(false);
    expect(step.state.frameIndex).toBe(11);
  });

  it("is a no-op when no utterance is in progress", () => {
    const idle = createEndpointer(config);

    const step = forceEndUtterance(idle);

    expect(step.event).toBeNull();
    expect(step.state).toBe(idle);
  });
});
