// Pure voice-activity endpointing (#219): turns a stream of audio energy frames into discrete
// "utterance started" / "utterance ended" decisions, with no DOM, Web Audio, timers, or I/O. The
// browser layer measures per-frame energy and feeds it here one frame at a time; every turn-taking
// decision lives in this module so it is deterministic and unit-testable without a real microphone.
//
// Model: a frame is "voiced" when its energy is strictly above the configured noise floor. Starting an
// utterance needs a sustained run of voiced frames (`minSpeechMs`) so a single noise spike never
// triggers; ending it needs a sustained run of silence (`endSilenceMs`) so a short intra-sentence pause
// never ends it. Both thresholds are debounce windows expressed in milliseconds and converted to whole
// frames using the per-frame duration.

export type EndpointConfig = Readonly<{
  // Duration each energy frame represents, in milliseconds (the sampling interval of the browser layer).
  frameMs: number;
  // Energy threshold; a frame is voiced when its energy is strictly greater than this floor.
  noiseFloor: number;
  // Sustained voiced duration required to confirm an utterance has started.
  minSpeechMs: number;
  // Sustained trailing silence required to confirm the utterance has ended.
  endSilenceMs: number;
}>;

export type UtteranceStartEvent = Readonly<{
  type: "utterance-start";
  // Frame index at which the start was confirmed (the minSpeechMs window completed here).
  frameIndex: number;
  // Frame index where the voiced run actually began — earlier than `frameIndex` by the speech window —
  // so a consumer can trim its capture back to the true onset rather than the confirmation point.
  speechStartFrameIndex: number;
}>;

export type UtteranceEndEvent = Readonly<{
  type: "utterance-end";
  // Frame index at which the end was confirmed (the endSilenceMs window completed here), or the current
  // position for a forced end.
  frameIndex: number;
}>;

export type EndpointEvent = UtteranceStartEvent | UtteranceEndEvent;

type Phase = "idle" | "speaking";

export type EndpointerState = Readonly<{
  config: EndpointConfig;
  phase: Phase;
  // Number of frames processed so far; also the index of the next frame to arrive.
  frameIndex: number;
  // Consecutive voiced frames seen while idle, tracking progress toward an utterance start.
  voicedRunFrames: number;
  // Frame index where the current voiced run began (meaningful only while `voicedRunFrames` > 0).
  voicedRunStart: number;
  // Consecutive silent frames seen while speaking, tracking progress toward an utterance end.
  silenceRunFrames: number;
}>;

export type EndpointStep = Readonly<{
  state: EndpointerState;
  event: EndpointEvent | null;
}>;

// Whole frames a debounce window spans. At least one frame so a window shorter than a single frame
// still requires a real frame of evidence; ceil so a window is never satisfied early by rounding down.
function windowFrames(windowMs: number, frameMs: number): number {
  return Math.max(1, Math.ceil(windowMs / frameMs));
}

export function createEndpointer(config: EndpointConfig): EndpointerState {
  return {
    config,
    frameIndex: 0,
    phase: "idle",
    silenceRunFrames: 0,
    voicedRunFrames: 0,
    voicedRunStart: 0
  };
}

// True while an utterance is in progress (start observed, end not yet). The browser layer uses this to
// know whether a forced "tap to finish" has anything to end and whether to keep buffering audio.
export function isCapturingUtterance(state: EndpointerState): boolean {
  return state.phase === "speaking";
}

// Feed one energy frame and get the next state plus any decision it triggered (at most one per frame).
export function pushFrame(state: EndpointerState, energy: number): EndpointStep {
  const { config, frameIndex } = state;
  const voiced = energy > config.noiseFloor;
  const next = frameIndex + 1;

  if (state.phase === "idle") {
    if (!voiced) {
      return {
        event: null,
        state: { ...state, frameIndex: next, voicedRunFrames: 0 }
      };
    }

    const runStart = state.voicedRunFrames === 0 ? frameIndex : state.voicedRunStart;
    const voicedRunFrames = state.voicedRunFrames + 1;

    if (voicedRunFrames >= windowFrames(config.minSpeechMs, config.frameMs)) {
      return {
        event: { frameIndex, speechStartFrameIndex: runStart, type: "utterance-start" },
        state: {
          ...state,
          frameIndex: next,
          phase: "speaking",
          silenceRunFrames: 0,
          voicedRunFrames: 0,
          voicedRunStart: runStart
        }
      };
    }

    return {
      event: null,
      state: { ...state, frameIndex: next, voicedRunFrames, voicedRunStart: runStart }
    };
  }

  if (voiced) {
    return {
      event: null,
      state: { ...state, frameIndex: next, silenceRunFrames: 0 }
    };
  }

  const silenceRunFrames = state.silenceRunFrames + 1;

  if (silenceRunFrames >= windowFrames(config.endSilenceMs, config.frameMs)) {
    return {
      event: { frameIndex, type: "utterance-end" },
      state: { ...state, frameIndex: next, phase: "idle", silenceRunFrames: 0, voicedRunFrames: 0 }
    };
  }

  return {
    event: null,
    state: { ...state, frameIndex: next, silenceRunFrames }
  };
}

// Manually end the current utterance ("tap to finish"), covering rough VAD on noisy devices. No frame
// is consumed; the end event carries the current position. A no-op (no event) when not speaking.
export function forceEndUtterance(state: EndpointerState): EndpointStep {
  if (state.phase !== "speaking") {
    return { event: null, state };
  }

  return {
    event: { frameIndex: state.frameIndex, type: "utterance-end" },
    state: { ...state, phase: "idle", silenceRunFrames: 0, voicedRunFrames: 0 }
  };
}
