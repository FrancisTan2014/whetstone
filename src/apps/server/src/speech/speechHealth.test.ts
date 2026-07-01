import { describe, expect, it } from "vitest";

import { checkSpeechHealth } from "./speechHealth.js";

describe("checkSpeechHealth", () => {
  it("warns with a setup hint when no Whisper is configured (on the fake)", () => {
    const report = checkSpeechHealth({ config: { whisper: undefined } });

    expect(report.status).toBe("fake");
    expect(report.message).toContain("pnpm setup --voice");
    expect(report.message).toContain("WHISPER_BINARY");
  });

  it("reports configured when a Whisper config is present", () => {
    const report = checkSpeechHealth({
      config: {
        whisper: { binaryPath: "/bin/whetstone-whisper", language: "en", modelPath: "small" }
      }
    });

    expect(report.status).toBe("configured");
  });
});
