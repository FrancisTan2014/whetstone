import { describe, expect, it } from "vitest";

import { checkSpeechHealth } from "./speechHealth.js";

const local = { binaryPath: "/bin/local-asr", modelIdentifier: "small" } as const;
const whisper = { binaryPath: "/bin/whetstone-whisper", modelPath: "small" } as const;

describe("checkSpeechHealth", () => {
  it("warns with a setup hint when no provider is configured (on the fake)", () => {
    const report = checkSpeechHealth({
      config: { provider: undefined, legacyAlsoPresent: false }
    });

    expect(report.status).toBe("fake");
    expect(report.message).toContain("pnpm setup:voice");
    expect(report.message).toContain("LOCAL_ASR_BINARY");
    expect(report.message).toContain("voice diary");
  });

  it("reports the local provider when the provider-neutral pair is configured", () => {
    const report = checkSpeechHealth({
      config: { provider: { kind: "local", local }, legacyAlsoPresent: false }
    });

    expect(report.status).toBe("local");
    expect(report.message).toContain("LOCAL_ASR_BINARY");
    expect(report.message).toContain("voice diary");
    expect(report.message).not.toContain("Legacy WHISPER_* is also set");
  });

  it("adds a migration hint when stale legacy keys sit alongside the authoritative new pair", () => {
    const report = checkSpeechHealth({
      config: { provider: { kind: "local", local }, legacyAlsoPresent: true }
    });

    expect(report.status).toBe("local");
    expect(report.message).toContain("Legacy WHISPER_* is also set and ignored");
    expect(report.message).toContain("remove it");
  });

  it("reports the legacy provider with a migration hint when only WHISPER_* is configured", () => {
    const report = checkSpeechHealth({
      config: { provider: { kind: "whisper", whisper }, legacyAlsoPresent: false }
    });

    expect(report.status).toBe("legacy");
    expect(report.message).toContain("legacy WHISPER_BINARY");
    expect(report.message).toContain("Migrate to LOCAL_ASR_BINARY");
    expect(report.message).toContain("voice diary");
  });

  it("emits pure-ASCII log messages so the Windows console renders them cleanly (#439)", () => {
    const messages = [
      checkSpeechHealth({ config: { provider: undefined, legacyAlsoPresent: false } }).message,
      checkSpeechHealth({
        config: { provider: { kind: "local", local }, legacyAlsoPresent: true }
      }).message,
      checkSpeechHealth({
        config: { provider: { kind: "whisper", whisper }, legacyAlsoPresent: false }
      }).message
    ];

    for (const message of messages) {
      expect([...message].every((ch) => (ch.codePointAt(0) ?? 0) <= 127)).toBe(true);
    }
  });
});
