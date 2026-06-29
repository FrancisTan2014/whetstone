// Thin browser audio layer for live turn-taking (#219). This is the only impure part of the engine: it
// touches Web Audio (`AudioContext`/`AnalyserNode`), `MediaRecorder`, `navigator.mediaDevices`, and real
// timers, none of which run in jsdom. Every turn-taking decision delegates to the pure `turnTaking`
// engine in `@whetstone/domain`; this file only measures per-frame microphone energy, forwards it, and
// dispatches the resulting effects to callbacks. It is therefore excluded from coverage (see
// vitest.config.ts), like the other browser boundaries in this feature (`browserVoiceOut.ts`).
//
// Continuous capture preserves the onset: a fresh `MediaRecorder` starts on `capture-start` — the first
// candidate voiced frame — so the recording already covers the utterance onset by the time the engine
// *confirms* the start `minSpeechMs` later. A candidate that dies (`capture-discard`) throws its
// recording away; a confirmed end (`utterance-end`, or a manual `finishUtterance()`) finalizes the blob
// and hands it to `onUtterance`. A confirmed start while the coach is playing is a barge-in: `onBargeIn`
// fires so the consumer can stop playback. No STT, coach, or TTS lives here — the blob is just handed off.

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
  // The learner finished an utterance; `audio` is the captured turn (onset included), ready for STT.
  onUtterance: (audio: Blob) => void;
  // The learner started speaking while the coach was playing — stop playback and switch to capture.
  onBargeIn?: () => void;
  // The learner started speaking while the coach was idle — a normal turn start.
  onUtteranceStart?: () => void;
}>;

export type LiveCapture = Readonly<{
  // Open the microphone and begin continuous turn-taking. Rejects if mic permission is denied.
  start: () => Promise<void>;
  // Stop sampling, release the microphone, and tear down audio resources (drops any in-flight capture).
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

// Feature-detect microphone capture before offering voice. `navigator.mediaDevices` is `undefined` in a
// non-secure context (plain http on a phone) and absent in jsdom, so the call must stay typed-only when
// this is false — never throw. Optional chaining keeps a missing `mediaDevices` from blowing up the check.
export function isVoiceCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" && typeof navigator.mediaDevices?.getUserMedia === "function"
  );
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
  // The active recording, paired with its own chunk buffer. Keeping the buffer recorder-local means a
  // stopped recorder's late `dataavailable`/`stop` events write to and emit from *its* buffer, so a new
  // candidate starting before the old recorder drains can never corrupt or drop the completed blob.
  let active: Readonly<{ recorder: MediaRecorder; buffer: Blob[] }> | null = null;

  // Begin (or keep) a recording from the candidate onset. Idempotent so the later confirmed start, which
  // also asks to record, does not restart and lose the buffered onset.
  function ensureRecording(): void {
    if (active !== null || stream === null) {
      return;
    }
    const buffer: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) {
        buffer.push(event.data);
      }
    });
    active = { buffer, recorder };
    recorder.start();
  }

  // Stop the current recording. When `emit` is true the assembled blob is handed to `onUtterance`;
  // otherwise the recording (a dead candidate or a torn-down session) is discarded.
  function stopRecording(emit: boolean): void {
    const current = active;
    if (current === null) {
      return;
    }
    active = null;
    const { buffer, recorder } = current;
    if (emit) {
      recorder.addEventListener("stop", () => {
        const type = recorder.mimeType;
        callbacks.onUtterance(new Blob(buffer, type ? { type } : undefined));
      });
    }
    recorder.stop();
  }

  function dispatch(step: TurnStep): void {
    state = step.state;
    const effect = step.effect;
    if (effect === null) {
      return;
    }
    switch (effect.type) {
      case "capture-start":
        ensureRecording();
        break;
      case "capture-discard":
        stopRecording(false);
        break;
      case "barge-in":
        callbacks.onBargeIn?.();
        ensureRecording();
        break;
      case "utterance-start":
        callbacks.onUtteranceStart?.();
        ensureRecording();
        break;
      case "utterance-end":
        stopRecording(true);
        break;
    }
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
    stopRecording(false);
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
