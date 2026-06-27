import { describe, expect, it } from "vitest";

import type { CommandRunner } from "./whisperProcess.js";
import {
  buildWhisperArgs,
  createWhisperSpeechInput,
  parseWhisperOutput,
  type WhisperConfig
} from "./whisperSpeechInput.js";

const config: WhisperConfig = {
  binaryPath: "whisper-cli",
  language: "en",
  modelPath: "/models/base.en.bin"
};

const rawOutput = JSON.stringify({
  segments: [
    {
      words: [
        { end: 0.4, start: 0, word: " Help" },
        { end: 0.9, start: 0.5, word: " yourself" }
      ]
    },
    { words: [{ end: 0.95, start: 0.9, word: "   " }] },
    { words: [{ end: 0.1, start: -0.02, word: "now" }] }
  ],
  text: "  Help yourself now  "
});

const mapped = {
  transcript: "Help yourself now",
  words: [
    { end: 400, start: 0, text: "Help" },
    { end: 900, start: 500, text: "yourself" },
    { end: 100, start: 0, text: "now" }
  ]
};

describe("buildWhisperArgs", () => {
  it("builds the documented offline CLI arguments", () => {
    expect(buildWhisperArgs(config, "/tmp/utterance.wav")).toEqual([
      "--model",
      "/models/base.en.bin",
      "--language",
      "en",
      "--output",
      "json",
      "--word-timestamps",
      "/tmp/utterance.wav"
    ]);
  });
});

describe("parseWhisperOutput", () => {
  it("maps seconds to ms, drops blank words, and clamps negatives", () => {
    expect(parseWhisperOutput(rawOutput)).toEqual(mapped);
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseWhisperOutput("not json")).toThrow("not valid JSON");
  });

  it.each([
    ["a non-object root", "123"],
    ["a null root", "null"],
    ["an array root", "[]"],
    ["a missing transcript", JSON.stringify({ segments: [] })],
    ["non-array segments", JSON.stringify({ segments: {}, text: "x" })],
    ["a non-record segment", JSON.stringify({ segments: [7], text: "x" })],
    ["non-array segment words", JSON.stringify({ segments: [{ words: {} }], text: "x" })],
    ["a non-record word", JSON.stringify({ segments: [{ words: [7] }], text: "x" })],
    [
      "a non-string word",
      JSON.stringify({ segments: [{ words: [{ end: 1, start: 0, word: 9 }] }], text: "x" })
    ],
    [
      "a non-number start",
      JSON.stringify({ segments: [{ words: [{ end: 1, start: "0", word: "a" }] }], text: "x" })
    ],
    [
      "a non-number end",
      JSON.stringify({ segments: [{ words: [{ end: "1", start: 0, word: "a" }] }], text: "x" })
    ],
    [
      "an end-before-start word",
      JSON.stringify({ segments: [{ words: [{ end: 0.5, start: 1, word: "a" }] }], text: "x" })
    ]
  ])("throws on %s", (_label, output) => {
    expect(() => parseWhisperOutput(output)).toThrow("did not match the expected");
  });
});

describe("createWhisperSpeechInput", () => {
  it("runs the configured binary with the built args and maps its output", async () => {
    let seen: { args: ReadonlyArray<string>; binaryPath: string } | undefined;
    const run: CommandRunner = (binaryPath, args) => {
      seen = { args, binaryPath };
      return Promise.resolve(rawOutput);
    };

    const speech = createWhisperSpeechInput({ config, run });
    const result = await speech.transcribe({ path: "/tmp/utterance.wav" });

    expect(result).toEqual(mapped);
    expect(seen?.binaryPath).toBe("whisper-cli");
    expect(seen?.args).toEqual(buildWhisperArgs(config, "/tmp/utterance.wav"));
  });

  it("uses the real process runner by default", async () => {
    const speech = createWhisperSpeechInput({
      config: { binaryPath: process.execPath, language: "en", modelPath: "m" }
    });
    // Node rejects the Whisper-shaped args, exercising the default runner end-to-end.
    await expect(speech.transcribe({ path: "/tmp/a.wav" })).rejects.toThrow();
  });
});
