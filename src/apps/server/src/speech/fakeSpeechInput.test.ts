import { describe, expect, it } from "vitest";

import type { Transcription } from "@whetstone/contracts";

import { createFakeSpeechInput } from "./fakeSpeechInput.js";

const transcription: Transcription = {
  transcript: "help yourself",
  words: [
    { end: 400, start: 0, text: "help" },
    { end: 900, start: 500, text: "yourself" }
  ]
};

describe("createFakeSpeechInput", () => {
  it("returns the injected transcription for any audio", async () => {
    const speech = createFakeSpeechInput(transcription);
    expect(await speech.transcribe({ path: "/tmp/a.wav" })).toEqual(transcription);
  });

  it("scripts the transcription as a function of the audio", async () => {
    const speech = createFakeSpeechInput((audio) => ({
      transcript: audio.path,
      words: []
    }));
    expect(await speech.transcribe({ path: "/tmp/b.wav" })).toEqual({
      transcript: "/tmp/b.wav",
      words: []
    });
  });
});
