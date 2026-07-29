import { describe, expect, it, vi } from "vitest";

import { createFakeSpeechInput } from "./fakeSpeechInput.js";
import type { LocalSpeechConfig } from "./localSpeechInput.js";
import { readSpeechConfig, resolveSpeechInput } from "./speechConfig.js";
import type { SpeechInput } from "./speechInput.js";
import type { WhisperConfig } from "./whisperSpeechInput.js";

const fake = createFakeSpeechInput({ transcript: "", words: [] });

function okConfig(env: NodeJS.ProcessEnv) {
  const result = readSpeechConfig(env);
  if (!result.ok) {
    throw new Error(`expected ok config, got error: ${result.error.message}`);
  }
  return result.config;
}

describe("readSpeechConfig", () => {
  it("is absent-config-safe: no env means no provider and no legacy leftover", () => {
    expect(okConfig({})).toEqual({ provider: undefined, legacyAlsoPresent: false });
  });

  it("reads the provider-neutral pair as the authoritative local provider", () => {
    expect(okConfig({ LOCAL_ASR_BINARY: "local-asr", LOCAL_ASR_MODEL: "small" })).toEqual({
      provider: { kind: "local", local: { binaryPath: "local-asr", modelIdentifier: "small" } },
      legacyAlsoPresent: false
    });
  });

  it("treats a partial new pair as an explicit configuration error with a setup remedy", () => {
    for (const env of [{ LOCAL_ASR_BINARY: "local-asr" }, { LOCAL_ASR_MODEL: "small" }]) {
      const result = readSpeechConfig(env);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("partially configured");
        expect(result.error.remedy).toContain("LOCAL_ASR_BINARY");
        expect(result.error.remedy).toContain("LOCAL_ASR_MODEL");
        expect(result.error.remedy).toContain("pnpm setup:voice");
      }
    }
  });

  it("treats a blank half of the new pair as partial (not a silent fake fallback)", () => {
    const result = readSpeechConfig({ LOCAL_ASR_BINARY: "  ", LOCAL_ASR_MODEL: "small" });
    expect(result.ok).toBe(false);
  });

  it("uses the complete legacy WHISPER_* pair as a fallback only when no new key is present", () => {
    expect(
      okConfig({ WHISPER_BINARY: "whisper-cli", WHISPER_MODEL_PATH: "/m/base.bin" })
    ).toEqual({
      provider: { kind: "whisper", whisper: { binaryPath: "whisper-cli", modelPath: "/m/base.bin" } },
      legacyAlsoPresent: false
    });
  });

  it("needs both legacy keys to fall back; a half legacy config stays on the fake", () => {
    expect(okConfig({ WHISPER_BINARY: "whisper-cli" }).provider).toBeUndefined();
    expect(okConfig({ WHISPER_MODEL_PATH: "/m/base.bin" }).provider).toBeUndefined();
    expect(
      okConfig({ WHISPER_BINARY: "  ", WHISPER_MODEL_PATH: "/m/base.bin" }).provider
    ).toBeUndefined();
  });

  it("lets the new pair win over a legacy pair and flags the mix for migration visibility", () => {
    expect(
      okConfig({
        LOCAL_ASR_BINARY: "local-asr",
        LOCAL_ASR_MODEL: "small",
        WHISPER_BINARY: "whisper-cli",
        WHISPER_MODEL_PATH: "/m/base.bin"
      })
    ).toEqual({
      provider: { kind: "local", local: { binaryPath: "local-asr", modelIdentifier: "small" } },
      legacyAlsoPresent: true
    });
  });

  it("flags even a single stale legacy key as a mixed config when the new pair is authoritative", () => {
    expect(
      okConfig({
        LOCAL_ASR_BINARY: "local-asr",
        LOCAL_ASR_MODEL: "small",
        WHISPER_BINARY: "whisper-cli"
      }).legacyAlsoPresent
    ).toBe(true);
  });
});

describe("resolveSpeechInput", () => {
  const local: LocalSpeechConfig = { binaryPath: "local-asr", modelIdentifier: "small" };
  const whisper: WhisperConfig = { binaryPath: "whisper-cli", modelPath: "/m/base.bin" };

  it("falls back to the fake when no provider is configured", () => {
    expect(
      resolveSpeechInput({
        config: { provider: undefined, legacyAlsoPresent: false },
        createLocal: () => fake,
        createWhisper: () => fake,
        fake
      })
    ).toBe(fake);
  });

  it("falls back to the fake when a local provider is set but no adapter is wired", () => {
    expect(
      resolveSpeechInput({
        config: { provider: { kind: "local", local }, legacyAlsoPresent: false },
        fake
      })
    ).toBe(fake);
  });

  it("falls back to the fake when a legacy provider is set but no adapter is wired", () => {
    expect(
      resolveSpeechInput({
        config: { provider: { kind: "whisper", whisper }, legacyAlsoPresent: false },
        fake
      })
    ).toBe(fake);
  });

  it("builds the local adapter from the config when both are present", () => {
    const real: SpeechInput = createFakeSpeechInput({ transcript: "local", words: [] });
    const createLocal = vi.fn((config: LocalSpeechConfig) => {
      expect(config).toEqual(local);
      return real;
    });
    const createWhisper = vi.fn(() => fake);

    expect(
      resolveSpeechInput({
        config: { provider: { kind: "local", local }, legacyAlsoPresent: false },
        createLocal,
        createWhisper,
        fake
      })
    ).toBe(real);
    expect(createLocal).toHaveBeenCalledOnce();
    expect(createWhisper).not.toHaveBeenCalled();
  });

  it("builds the legacy Whisper adapter from the config when both are present", () => {
    const real: SpeechInput = createFakeSpeechInput({ transcript: "whisper", words: [] });
    const createWhisper = vi.fn((config: WhisperConfig) => {
      expect(config).toEqual(whisper);
      return real;
    });
    const createLocal = vi.fn(() => fake);

    expect(
      resolveSpeechInput({
        config: { provider: { kind: "whisper", whisper }, legacyAlsoPresent: false },
        createLocal,
        createWhisper,
        fake
      })
    ).toBe(real);
    expect(createWhisper).toHaveBeenCalledOnce();
    expect(createLocal).not.toHaveBeenCalled();
  });
});
