import { describe, expect, it } from "vitest";

import type { CommandRunner } from "./speechProcess.js";
import {
  buildWhisperArgs,
  createWhisperSpeechInput,
  parseWhisperOutput,
  type WhisperConfig
} from "./whisperSpeechInput.js";

const config: WhisperConfig = {
  binaryPath: "whisper-cli",
  modelPath: "/models/base.en.bin"
};

const rawOutput = JSON.stringify({
  language: "en",
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
  language: "en",
  transcript: "Help yourself now",
  words: [
    { end: 400, start: 0, text: "Help" },
    { end: 900, start: 500, text: "yourself" },
    { end: 100, start: 0, text: "now" }
  ]
};

describe("buildWhisperArgs", () => {
  it("always requests automatic language detection (--language auto)", () => {
    expect(buildWhisperArgs(config, "recordings\\utterance.wav")).toEqual([
      "--model",
      "/models/base.en.bin",
      "--language",
      "auto",
      "--output",
      "json",
      "--word-timestamps",
      "recordings\\utterance.wav"
    ]);
  });
});

describe("parseWhisperOutput", () => {
  it("maps seconds to ms, drops blank words, clamps negatives, and reads the detected language", () => {
    expect(parseWhisperOutput(rawOutput)).toEqual(mapped);
  });

  it("keeps every utterance of a mixed-language capture and tolerates the additive per-segment language", () => {
    // #909: for `--language auto` the wrapper now detects language per VAD utterance and tags each
    // segment with its own `language`. The adapter must collect words across ALL segments in absolute
    // ms (the English utterance at 9 s is retained, not dropped) and read the top-level opening
    // language; the extra per-segment `language` is informational and must not affect parsing.
    const mixedLanguage = JSON.stringify({
      language: "zh",
      segments: [
        { language: "zh", words: [{ end: 0.8, start: 0, word: "你好" }] },
        { language: "en", words: [{ end: 9.4, start: 9.0, word: " Help" }] }
      ],
      text: "你好 Help"
    });
    expect(parseWhisperOutput(mixedLanguage)).toEqual({
      language: "zh",
      transcript: "你好 Help",
      words: [
        { end: 800, start: 0, text: "你好" },
        { end: 9400, start: 9000, text: "Help" }
      ]
    });
  });

  it("reports a null language when the model detected none", () => {
    const withoutLanguage = JSON.stringify({
      segments: [{ words: [{ end: 0.4, start: 0, word: "Hi" }] }],
      text: "Hi"
    });
    expect(parseWhisperOutput(withoutLanguage)).toEqual({
      language: null,
      transcript: "Hi",
      words: [{ end: 400, start: 0, text: "Hi" }]
    });
  });

  it("reports a null language when the reported language is not a string", () => {
    const nonStringLanguage = JSON.stringify({
      language: 7,
      segments: [{ words: [{ end: 0.4, start: 0, word: "Hi" }] }],
      text: "Hi"
    });
    expect(parseWhisperOutput(nonStringLanguage).language).toBeNull();
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
    const result = await speech.transcribe({ path: "recordings\\utterance.wav" });

    expect(result).toEqual(mapped);
    expect(seen?.binaryPath).toBe("whisper-cli");
    expect(seen?.args).toEqual(buildWhisperArgs(config, "recordings\\utterance.wav"));
  });

  it("uses the real process runner by default", async () => {
    const speech = createWhisperSpeechInput({
      config: { binaryPath: process.execPath, modelPath: "m" }
    });
    // Node rejects the Whisper-shaped args, exercising the default runner end-to-end.
    await expect(speech.transcribe({ path: "recordings\\a.wav" })).rejects.toThrow();
  });
});
