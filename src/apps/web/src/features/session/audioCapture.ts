// Records a short spoken utterance from the microphone as raw audio bytes (browser MediaRecorder), to
// be sent to the STT seam (#207). This is a thin browser-API boundary — it touches `navigator`,
// `MediaRecorder`, and real timers that cannot be exercised in jsdom — so it is excluded from coverage
// (see vitest.config.ts) and the session page injects a fake in tests. The session logic that calls
// the STT seam and submits the turn is fully covered.
const MAX_RECORDING_MS = 15000;

export async function captureMicrophoneAudio(): Promise<Uint8Array> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const recorder = new MediaRecorder(stream);
  const chunks: Array<Blob> = [];

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const stopped = new Promise<void>((resolve) => {
    recorder.addEventListener("stop", () => resolve());
  });

  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, MAX_RECORDING_MS));
  recorder.stop();
  await stopped;

  for (const track of stream.getTracks()) {
    track.stop();
  }

  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}
