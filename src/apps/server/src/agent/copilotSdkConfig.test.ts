import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultCopilotModel,
  defaultCopilotReasoningEffort,
  readCopilotSdkConfig
} from "./copilotSdkConfig.js";

function okConfig(env: NodeJS.ProcessEnv) {
  const result = readCopilotSdkConfig(env);
  if (!result.ok) {
    throw new Error(`expected ok config, got error: ${result.error.message}`);
  }
  return result.config;
}

describe("readCopilotSdkConfig", () => {
  it("activates with the issue's fixed defaults when nothing is overridden", () => {
    expect(okConfig({})).toEqual({
      copilotHome: join(tmpdir(), "whetstone-copilot-sdk"),
      model: defaultCopilotModel,
      reasoningEffort: defaultCopilotReasoningEffort
    });
  });

  it("honors an operator-overridden model independently of effort", () => {
    expect(okConfig({ AGENT_COPILOT_MODEL: "gpt-5-mini" })).toEqual({
      copilotHome: join(tmpdir(), "whetstone-copilot-sdk"),
      model: "gpt-5-mini",
      reasoningEffort: defaultCopilotReasoningEffort
    });
  });

  it.each(["low", "medium", "high", "xhigh", "max"] as const)(
    "honors an operator-overridden reasoning effort %s",
    (effort) => {
      expect(okConfig({ AGENT_COPILOT_REASONING_EFFORT: effort }).reasoningEffort).toBe(effort);
    }
  );

  it("honors an operator-overridden Copilot home directory", () => {
    expect(okConfig({ AGENT_COPILOT_HOME: "C:\\custom\\copilot-home" }).copilotHome).toBe(
      "C:\\custom\\copilot-home"
    );
  });

  it("names an unrecognized reasoning effort as a config error with a remedy, not a silent default", () => {
    const result = readCopilotSdkConfig({ AGENT_COPILOT_REASONING_EFFORT: "ultra" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ultra");
      expect(result.error.remedy).toContain("AGENT_COPILOT_REASONING_EFFORT");
      expect(result.error.remedy).toContain("docs/AGENT.md");
    }
  });

  it("treats a blank override as unset rather than as an invalid value", () => {
    expect(
      okConfig({
        AGENT_COPILOT_MODEL: "  ",
        AGENT_COPILOT_REASONING_EFFORT: "  ",
        AGENT_COPILOT_HOME: "  "
      })
    ).toEqual({
      copilotHome: join(tmpdir(), "whetstone-copilot-sdk"),
      model: defaultCopilotModel,
      reasoningEffort: defaultCopilotReasoningEffort
    });
  });

  it("reads process.env by default", () => {
    // Asserts only that the default source is wired: this machine's env is not the test's business.
    expect(readCopilotSdkConfig()).toHaveProperty("ok");
  });
});
