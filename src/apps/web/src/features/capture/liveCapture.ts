// Thin browser audio layer for voice-diary capture (#455/#565). This is the only impure part of the
// capture path: it touches Web Audio (`AudioContext`/`AnalyserNode`), `MediaRecorder`,
// `navigator.mediaDevices`, and real timers, none of which run in jsdom. Every voice-activity decision
// delegates to the pure `endpointing` VAD in `@whetstone/domain`; this file only measures per-frame
// microphone energy, forwards it, and dispatches the resulting effects to callbacks. It is therefore
// excluded from coverage (see vitest.config.ts), like the sibling `captureVoice.ts` adapter.
//
// Continuous capture preserves the onset: a fresh `MediaRecorder` starts on `speech-candidate` — the
// first candidate voiced frame — so the recording already covers the utterance onset by the time the VAD
// *confirms* the start `minSpeechMs` later. A candidate that dies (`speech-aborted`) throws its recording
// away; a confirmed end (`utterance-end`, or a manual `finishUtterance()`) finalizes the blob and hands
// it to `onUtterance`. No STT or persistence lives here — the blob is just handed off.

import {
  createEndpointer,
  forceEndUtterance,
  pushFrame,
  type EndpointConfig,
  type EndpointStep
} from "@whetstone/domain";

export type LiveCaptureCallbacks = Readonly<{
  // The speaker finished an utterance; `audio` is the captured turn (onset included), ready for STT.
  onUtterance: (audio: Blob) => void;
  // The speaker started speaking (a confirmed utterance start) — a normal capture start.
  onUtteranceStart?: () => void;
}>;

export type LiveCapture = Readonly<{
  // Open the microphone and begin continuous voice-activity capture. Rejects if mic permission is denied.
  start: () => Promise<void>;
  // Stop sampling, release the microphone, and tear down audio resources (drops any in-flight capture).
  stop: () => void;
  // "Tap to finish": force the current utterance to end (covers rough VAD on noisy devices).
  finishUtterance: () => void;
}>;

// Defaults tuned for conversational speech sampled at 30ms frames: a short start window so capture feels
// responsive, and a generous end-silence that acts only as a backstop — the speaker owns the turn
// boundary via the "Done" control (#436), so a natural mid-sentence pause (1-3s) never cuts them off.
const defaultEndpointConfig: EndpointConfig = {
  endSilenceMs: 3000,
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
  let state = createEndpointer(config);
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

  function dispatch(step: EndpointStep): void {
    state = step.state;
    const event = step.event;
    if (event === null) {
      return;
    }
    switch (event.type) {
      case "speech-candidate":
        ensureRecording();
        break;
      case "speech-aborted":
        stopRecording(false);
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
    dispatch(pushFrame(state, frameEnergy(buffer)));
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
      dispatch(forceEndUtterance(state));
    },
    start,
    stop
  };
}
