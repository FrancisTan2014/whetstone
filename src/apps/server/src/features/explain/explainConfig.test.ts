import { describe, expect, it } from "vitest";

import { readExplainFeatureConfig, resolveExplainCapability } from "./explainConfig.js";

describe("readExplainFeatureConfig", () => {
  it("is disabled when the env var is absent", () => {
    expect(readExplainFeatureConfig({})).toEqual({ enabled: false });
  });

  it.each(["1", "true", "TRUE", " true "])("is enabled for %j", (value) => {
    expect(readExplainFeatureConfig({ AGENT_COPILOT_EXPLAIN_ENABLED: value })).toEqual({
      enabled: true
    });
  });

  it.each(["0", "false", "no", ""])("is disabled for %j", (value) => {
    expect(readExplainFeatureConfig({ AGENT_COPILOT_EXPLAIN_ENABLED: value })).toEqual({
      enabled: false
    });
  });
});

describe("resolveExplainCapability", () => {
  it("reports disabled with a remedy when opted out", () => {
    const capability = resolveExplainCapability({ enabled: false });
    expect(capability).toMatchObject({ enabled: false, reason: "feature_disabled" });
    if (!capability.enabled) {
      expect(capability.remedy.length).toBeGreaterThan(0);
    }
  });

  it("reports enabled with no extra fields when opted in", () => {
    expect(resolveExplainCapability({ enabled: true })).toEqual({ enabled: true });
  });
});
