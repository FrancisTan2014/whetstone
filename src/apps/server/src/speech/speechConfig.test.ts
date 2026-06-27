import { describe, expect, it, vi } from "vitest";

import { createFakeSpeechInput } from "./fakeSpeechInput.js";
import { readSpeechConfig, resolveSpeechInput } from "./speechConfig.js";
import type { SpeechInput } from "./speechInput.js";
import type { WhisperConfig } from "./whisperSpeechInput.js";

const fake = createFakeSpeechInput({ transcript: "", words: [] });

describe("readSpeechConfig", () => {
  it("is absent-config-safe: no env means no Whisper", () => {
    expect(readSpeechConfig({})).toEqual({ whisper: undefined });
  });

  it("needs both a binary and a model path", () => {
    expect(readSpeechConfig({ WHISPER_BINARY: "whisper-cli" }).whisper).toBeUndefined();
    expect(readSpeechConfig({ WHISPER_MODEL_PATH: "/m/base.bin" }).whisper).toBeUndefined();
    expect(
      readSpeechConfig({ WHISPER_BINARY: "  ", WHISPER_MODEL_PATH: "/m/base.bin" }).whisper
    ).toBeUndefined();
  });

  it("reads a full Whisper config, defaulting the language to en", () => {
    expect(
      readSpeechConfig({ WHISPER_BINARY: "whisper-cli", WHISPER_MODEL_PATH: "/m/base.bin" }).whisper
    ).toEqual({ binaryPath: "whisper-cli", language: "en", modelPath: "/m/base.bin" });
  });

  it("honours an explicit language", () => {
    expect(
      readSpeechConfig({
        WHISPER_BINARY: "whisper-cli",
        WHISPER_LANGUAGE: "zh",
        WHISPER_MODEL_PATH: "/m/base.bin"
      }).whisper?.language
    ).toBe("zh");
  });
});

describe("resolveSpeechInput", () => {
  const whisper: WhisperConfig = {
    binaryPath: "whisper-cli",
    language: "en",
    modelPath: "/m/base.bin"
  };

  it("falls back to the fake when no Whisper is configured", () => {
    expect(
      resolveSpeechInput({ config: { whisper: undefined }, createWhisper: () => fake, fake })
    ).toBe(fake);
  });

  it("falls back to the fake when configured but no adapter is wired", () => {
    expect(resolveSpeechInput({ config: { whisper }, fake })).toBe(fake);
  });

  it("builds the Whisper adapter from the config when both are present", () => {
    const real: SpeechInput = createFakeSpeechInput({ transcript: "real", words: [] });
    const createWhisper = vi.fn((config: WhisperConfig) => {
      expect(config).toEqual(whisper);
      return real;
    });

    expect(resolveSpeechInput({ config: { whisper }, createWhisper, fake })).toBe(real);
    expect(createWhisper).toHaveBeenCalledOnce();
  });
});
