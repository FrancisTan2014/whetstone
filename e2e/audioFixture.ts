// The voice-capture clip the #801 E2E uploads. Its bytes are a REAL, valid PCM WAV (RIFF/WAVE): a short
// mono 16-bit sine tone. Two properties matter end to end:
//   1. The env-gated fixture speech lane (VOICE_CAPTURE_FIXTURE_TRANSCRIPT=1, set in stack.ts) only returns
//      a transcript for genuine WAV bytes, so this clip transcribes to a fixed English note and the capture
//      reaches `ready` — giving the spec a real voice entry whose retained recording it can audit. Garbage
//      (non-WAV) bytes still transcribe to empty, so the #675 setup-required failure path stays intact.
//   2. The bytes are a decodable waveform, so Chromium's native <audio> element loads and seeks it without
//      a media console error (the E2E page fixture fails on any console error).
// Generated in-process — no binary committed to the repo, mirroring pdfFixture.ts.

const SAMPLE_RATE = 8000;
const DURATION_SECONDS = 1;
const FREQUENCY_HZ = 440;

function buildWav(): Buffer {
  const sampleCount = SAMPLE_RATE * DURATION_SECONDS;
  const dataSize = sampleCount * 2; // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");

  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // PCM fmt chunk size
  buffer.writeUInt16LE(1, 20); // audio format: PCM
  buffer.writeUInt16LE(1, 22); // channels: mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate = rate * blockAlign
  buffer.writeUInt16LE(2, 32); // block align = channels * bytesPerSample
  buffer.writeUInt16LE(16, 34); // bits per sample

  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < sampleCount; i += 1) {
    const amplitude = Math.sin((2 * Math.PI * FREQUENCY_HZ * i) / SAMPLE_RATE);
    buffer.writeInt16LE(Math.round(amplitude * 0x3fff), 44 + i * 2);
  }

  return buffer;
}

export const voiceClipFixture = {
  buffer: buildWav(),
  mimeType: "audio/wav"
} as const;

// The transcript the fixture speech lane returns for the WAV clip above (see src/apps/server/src/index.ts).
// The spec asserts the ready entry's transcript matches this, proving the audited source is the retained
// recording's transcription.
export const VOICE_CLIP_TRANSCRIPT = "This is my recorded diary note for today.";
