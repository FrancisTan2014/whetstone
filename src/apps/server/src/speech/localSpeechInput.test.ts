import { describe, expect, it } from "vitest";

import {
  buildContractVersionArgs,
  buildLocalSpeechArgs,
  createLocalSpeechInput,
  LOCAL_SPEECH_CONTRACT_VERSION,
  parseLocalSpeechOutput,
  type LocalSpeechConfig
} from "./localSpeechInput.js";
import type { CommandRunner } from "./speechProcess.js";

const config: LocalSpeechConfig = {
  binaryPath: "local-asr",
  modelIdentifier: "small"
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

describe("buildContractVersionArgs", () => {
  it("asks the executable for its protocol version and nothing else (loads no model)", () => {
    expect(buildContractVersionArgs()).toEqual(["--contract-version"]);
  });

  it("pins the supported protocol version", () => {
    expect(LOCAL_SPEECH_CONTRACT_VERSION).toBe("1");
  });
});

describe("buildLocalSpeechArgs", () => {
  it("passes the model identifier, a JSON output request, and the audio path - provider-neutral", () => {
    expect(buildLocalSpeechArgs(config, "recordings\\utterance.wav")).toEqual([
      "--model",
      "small",
      "--output",
      "json",
      "recordings\\utterance.wav"
    ]);
  });

  it("forces no language and no engine-specific alignment flag", () => {
    const args = buildLocalSpeechArgs(config, "a.wav");
    expect(args).not.toContain("--language");
    expect(args).not.toContain("--word-timestamps");
  });
});

describe("parseLocalSpeechOutput", () => {
  it("maps seconds to ms, drops blank words, clamps negatives, and reads the detected language", () => {
    expect(parseLocalSpeechOutput(rawOutput)).toEqual(mapped);
  });

  it("reports a null language when the provider detected none", () => {
    const withoutLanguage = JSON.stringify({
      segments: [{ words: [{ end: 0.4, start: 0, word: "Hi" }] }],
      text: "Hi"
    });
    expect(parseLocalSpeechOutput(withoutLanguage)).toEqual({
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
    expect(parseLocalSpeechOutput(nonStringLanguage).language).toBeNull();
  });

  it("accepts a transcript with no aligner: segments omitted -> empty words evidence", () => {
    const noSegments = JSON.stringify({ language: "en", text: "Help yourself" });
    expect(parseLocalSpeechOutput(noSegments)).toEqual({
      language: "en",
      transcript: "Help yourself",
      words: []
    });
  });

  it("accepts an empty segments array as empty words evidence", () => {
    expect(parseLocalSpeechOutput(JSON.stringify({ segments: [], text: "hi" })).words).toEqual([]);
  });

  it("accepts a segment whose words are omitted as contributing no timings", () => {
    const wordlessSegment = JSON.stringify({ segments: [{}], text: "hi" });
    expect(parseLocalSpeechOutput(wordlessSegment).words).toEqual([]);
  });

  it("throws on output that is not JSON", () => {
    expect(() => parseLocalSpeechOutput("not json")).toThrow("not valid JSON");
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
  ])("throws on %s (supplied timings stay strictly validated)", (_label, output) => {
    expect(() => parseLocalSpeechOutput(output)).toThrow("did not match the expected");
  });
});

describe("createLocalSpeechInput", () => {
  it("runs the configured binary with the built args and maps its output", async () => {
    let seen: { args: ReadonlyArray<string>; binaryPath: string } | undefined;
    const run: CommandRunner = (binaryPath, args) => {
      seen = { args, binaryPath };
      return Promise.resolve(rawOutput);
    };

    const speech = createLocalSpeechInput({ config, run });
    const result = await speech.transcribe({ path: "recordings\\utterance.wav" });

    expect(result).toEqual(mapped);
    expect(seen?.binaryPath).toBe("local-asr");
    expect(seen?.args).toEqual(buildLocalSpeechArgs(config, "recordings\\utterance.wav"));
  });

  it("returns a valid transcript with empty word evidence from an aligner-less provider", async () => {
    const run: CommandRunner = () =>
      Promise.resolve(JSON.stringify({ language: null, text: "just words" }));

    const speech = createLocalSpeechInput({ config, run });
    expect(await speech.transcribe({ path: "a.wav" })).toEqual({
      language: null,
      transcript: "just words",
      words: []
    });
  });

  it("uses the real process runner by default", async () => {
    const speech = createLocalSpeechInput({
      config: { binaryPath: process.execPath, modelIdentifier: "m" }
    });
    // Node rejects the local-speech-shaped args, exercising the default runner end-to-end.
    await expect(speech.transcribe({ path: "recordings\\a.wav" })).rejects.toThrow();
  });
});
