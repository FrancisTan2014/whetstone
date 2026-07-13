import { describe, expect, it } from "vitest";

import { parseTranscription } from "./speechContracts.js";

describe("parseTranscription", () => {
  const transcription = {
    transcript: "help yourself",
    words: [
      { end: 400, start: 0, text: "help" },
      { end: 900, start: 500, text: "yourself" }
    ]
  };

  it("round-trips a valid transcription", () => {
    expect(parseTranscription(transcription)).toEqual(transcription);
  });

  it("rejects a non-integer word offset", () => {
    expect(() =>
      parseTranscription({ transcript: "hi", words: [{ end: 1, start: 0.5, text: "hi" }] })
    ).toThrow();
  });

  it("rejects a negative word offset", () => {
    expect(() =>
      parseTranscription({ transcript: "hi", words: [{ end: 1, start: -1, text: "hi" }] })
    ).toThrow();
  });

  it("rejects a blank word text", () => {
    expect(() =>
      parseTranscription({ transcript: "hi", words: [{ end: 1, start: 0, text: "  " }] })
    ).toThrow();
  });

  it("rejects an end-before-start word", () => {
    expect(() =>
      parseTranscription({ transcript: "hi", words: [{ end: 400, start: 900, text: "hi" }] })
    ).toThrow();
  });

  it("rejects unknown fields", () => {
    expect(() => parseTranscription({ extra: true, transcript: "hi", words: [] })).toThrow();
  });
});
