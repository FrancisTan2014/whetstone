import { describe, expect, it } from "vitest";

import { createFakeSpeechInput } from "./fakeSpeechInput.js";

const scripted = {
  transcript: "help yourself",
  words: [
    { end: 400, start: 0, text: "help" },
    { end: 900, start: 500, text: "yourself" }
  ]
};

describe("createFakeSpeechInput", () => {
  it("returns the injected transcription for any audio, defaulting the detected language to null", async () => {
    const speech = createFakeSpeechInput(scripted);
    expect(await speech.transcribe({ path: "/tmp/a.wav" })).toEqual({
      ...scripted,
      language: null
    });
  });

  it("echoes an explicitly scripted detected language", async () => {
    const speech = createFakeSpeechInput({ ...scripted, language: "zh" });
    expect((await speech.transcribe({ path: "/tmp/a.wav" })).language).toBe("zh");
  });

  it("scripts the transcription as a function of the audio", async () => {
    const speech = createFakeSpeechInput((audio) => ({
      transcript: audio.path,
      words: []
    }));
    expect(await speech.transcribe({ path: "/tmp/b.wav" })).toEqual({
      language: null,
      transcript: "/tmp/b.wav",
      words: []
    });
  });
});
