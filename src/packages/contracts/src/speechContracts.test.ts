import { describe, expect, it } from "vitest";

import { parseTranscription } from "./speechContracts.js";

describe("parseTranscription", () => {
  const transcription = {
    language: "en",
    transcript: "help yourself",
    words: [
      { end: 400, start: 0, text: "help" },
      { end: 900, start: 500, text: "yourself" }
    ]
  };

  it("round-trips a valid transcription", () => {
    expect(parseTranscription(transcription)).toEqual(transcription);
  });

  it("accepts a null detected language (Whisper reported none)", () => {
    expect(parseTranscription({ ...transcription, language: null }).language).toBeNull();
  });

  it("rejects a non-string, non-null language", () => {
    expect(() => parseTranscription({ ...transcription, language: 7 })).toThrow();
  });

  it("rejects a missing language field", () => {
    expect(() => parseTranscription({ transcript: "hi", words: [] })).toThrow();
  });

  it("accepts a valid transcript with empty word evidence (a provider with no aligner, #799)", () => {
    expect(parseTranscription({ language: null, transcript: "help yourself", words: [] })).toEqual({
      language: null,
      transcript: "help yourself",
      words: []
    });
  });

  it("rejects a non-integer word offset", () => {
    expect(() =>
      parseTranscription({
        language: null,
        transcript: "hi",
        words: [{ end: 1, start: 0.5, text: "hi" }]
      })
    ).toThrow();
  });

  it("rejects a negative word offset", () => {
    expect(() =>
      parseTranscription({
        language: null,
        transcript: "hi",
        words: [{ end: 1, start: -1, text: "hi" }]
      })
    ).toThrow();
  });

  it("rejects a blank word text", () => {
    expect(() =>
      parseTranscription({
        language: null,
        transcript: "hi",
        words: [{ end: 1, start: 0, text: "  " }]
      })
    ).toThrow();
  });

  it("rejects an end-before-start word", () => {
    expect(() =>
      parseTranscription({
        language: null,
        transcript: "hi",
        words: [{ end: 400, start: 900, text: "hi" }]
      })
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() =>
      parseTranscription({ extra: true, language: null, transcript: "hi", words: [] })
    ).toThrow();
  });
});
