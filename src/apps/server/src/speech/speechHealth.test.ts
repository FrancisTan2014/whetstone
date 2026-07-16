import { describe, expect, it } from "vitest";

import { checkSpeechHealth } from "./speechHealth.js";

describe("checkSpeechHealth", () => {
  it("warns with a setup hint when no Whisper is configured (on the fake)", () => {
    const report = checkSpeechHealth({ config: { whisper: undefined } });

    expect(report.status).toBe("fake");
    expect(report.message).toContain("pnpm setup:voice");
    expect(report.message).toContain("WHISPER_BINARY");
    expect(report.message).toContain("voice diary");
  });

  it("reports configured when a Whisper config is present", () => {
    const report = checkSpeechHealth({
      config: {
        whisper: { binaryPath: "/bin/whetstone-whisper", modelPath: "small" }
      }
    });

    expect(report.status).toBe("configured");
    expect(report.message).toContain("voice diary");
  });

  it("emits pure-ASCII log messages so the Windows console renders them cleanly (#439)", () => {
    const messages = [
      checkSpeechHealth({ config: { whisper: undefined } }).message,
      checkSpeechHealth({
        config: {
          whisper: { binaryPath: "/bin/whetstone-whisper", modelPath: "small" }
        }
      }).message
    ];

    for (const message of messages) {
      expect([...message].every((ch) => (ch.codePointAt(0) ?? 0) <= 127)).toBe(true);
    }
  });
});
