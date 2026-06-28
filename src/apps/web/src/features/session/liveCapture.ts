// Thin browser audio layer for live turn-taking (#219). This is the only impure part of the engine: it
// touches Web Audio (`AudioContext`/`AnalyserNode`), `MediaRecorder`, `navigator.mediaDevices`, and real
// timers, none of which run in jsdom. Every turn-taking decision delegates to the pure `turnTaking`
// engine in `@whetstone/domain`; this file only measures per-frame microphone energy, forwards it, and
// dispatches the resulting effects to callbacks. It is therefore excluded from coverage (see
// vitest.config.ts), like the existing `audioCapture.ts` mic boundary.
//
// Lifecycle: `start()` opens the mic and begins sampling energy every `frameMs`. When the engine decides
// the learner has started speaking, a fresh `MediaRecorder` captures the utterance; when it decides the
// utterance ended (silence window, or a manual `finishUtterance()`), the recording stops and the audio
// blob is handed to `onUtterance`. A start while the coach is playing is a barge-in: `onBargeIn` fires so
// the consumer can stop playback. No STT, coach, or TTS lives here — the blob is simply handed off.

import {
  createTurnTaking,
  finishTurn,
  observeFrame,
  setCoachPlaying,
  type EndpointConfig,
  type TurnStep,
  type TurnTakingState
} from "@whetstone/domain";

export type LiveCaptureCallbacks = Readonly<{
  // The learner finished an utterance; `audio` is the captured turn, ready for the STT seam.
  onUtterance: (audio: Blob) => void;
  // The learner started speaking while the coach was playing — stop playback and switch to capture.
  onBargeIn?: () => void;
  // The learner started speaking while the coach was idle — a normal turn start.
  onUtteranceStart?: () => void;
}>;

export type LiveCapture = Readonly<{
  // Open the microphone and begin continuous turn-taking. Rejects if mic permission is denied.
  start: () => Promise<void>;
  // Stop sampling, release the microphone, and tear down audio resources.
  stop: () => void;
  // Tell the engine whether the coach is currently speaking, so a later start reads as barge-in.
  setCoachPlaying: (playing: boolean) => void;
  // "Tap to finish": force the current utterance to end (covers rough VAD on noisy devices).
  finishUtterance: () => void;
}>;

// Defaults tuned for conversational speech sampled at 30ms frames: a short start window so the turn
// feels responsive, a longer end-silence so natural mid-sentence pauses do not cut the learner off.
export const defaultEndpointConfig: EndpointConfig = {
  endSilenceMs: 700,
  frameMs: 30,
  minSpeechMs: 150,
  noiseFloor: 0.02
};

// Root-mean-square amplitude of a time-domain frame in [-1, 1] — a cheap, robust energy proxy for VAD.
function frameEnergy(samples: Float32Array): number {
  let sumSquares = 0;
  for (const sample of samples) {
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / samples.length);
}

export function createLiveCapture(
  callbacks: LiveCaptureCallbacks,
  config: EndpointConfig = defaultEndpointConfig
): LiveCapture {
  let state: TurnTakingState = createTurnTaking(config);
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let sampleTimer: ReturnType<typeof setInterval> | null = null;
  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];

  function beginUtteranceRecording(): void {
    if (stream === null) {
      return;
    }
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    });
    recorder.start();
  }

  function endUtteranceRecording(): void {
    const active = recorder;
    if (active === null) {
      return;
    }
    recorder = null;
    const captured = chunks;
    active.addEventListener("stop", () => {
      callbacks.onUtterance(
        new Blob(captured, active.mimeType ? { type: active.mimeType } : undefined)
      );
    });
    active.stop();
  }

  function dispatch(step: TurnStep): void {
    state = step.state;
    const effect = step.effect;
    if (effect === null) {
      return;
    }
    if (effect.type === "utterance-end") {
      endUtteranceRecording();
      return;
    }
    if (effect.type === "barge-in") {
      callbacks.onBargeIn?.();
    } else {
      callbacks.onUtteranceStart?.();
    }
    beginUtteranceRecording();
  }

  function sample(): void {
    if (analyser === null) {
      return;
    }
    const buffer = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(buffer);
    dispatch(observeFrame(state, frameEnergy(buffer)));
  }

  async function start(): Promise<void> {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    source.connect(analyser);
    sampleTimer = setInterval(sample, config.frameMs);
  }

  function stop(): void {
    if (sampleTimer !== null) {
      clearInterval(sampleTimer);
      sampleTimer = null;
    }
    if (recorder !== null) {
      recorder.stop();
      recorder = null;
    }
    if (stream !== null) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
      stream = null;
    }
    if (audioContext !== null) {
      void audioContext.close();
      audioContext = null;
    }
    analyser = null;
  }

  return {
    finishUtterance: () => {
      dispatch(finishTurn(state));
    },
    setCoachPlaying: (playing: boolean) => {
      state = setCoachPlaying(state, playing);
    },
    start,
    stop
  };
}
