import { describe, expect, it } from "vitest";

import { readAgentConfig, resolveAgent } from "./agentConfig.js";
import { isAgentError } from "./agentFailure.js";
import type { Agent } from "./agentSession.js";
import { createFakeAgent } from "./fakeAgent.js";

const fake = createFakeAgent("fake reply");

function okConfig(env: NodeJS.ProcessEnv) {
  const result = readAgentConfig(env);
  if (!result.ok) {
    throw new Error(`expected ok config, got error: ${result.error.message}`);
  }
  return result.config;
}

describe("readAgentConfig", () => {
  it("is absent-config-safe: no env means no provider", () => {
    expect(okConfig({})).toEqual({ provider: undefined });
  });

  it("enables a provider only when both keys are set", () => {
    expect(okConfig({ AGENT_BINARY: "local-agent", AGENT_MODEL: "qwen-coder" })).toEqual({
      provider: { binaryPath: "local-agent", modelIdentifier: "qwen-coder" }
    });
  });

  it.each([
    ["AGENT_BINARY", { AGENT_MODEL: "qwen-coder" }],
    ["AGENT_MODEL", { AGENT_BINARY: "local-agent" }]
  ])("names %s as the missing key instead of silently using the fake", (missingKey, env) => {
    const result = readAgentConfig(env);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain(missingKey);
      expect(result.error.remedy).toContain("AGENT_BINARY");
      expect(result.error.remedy).toContain("AGENT_MODEL");
      expect(result.error.remedy).toContain("docs/AGENT.md");
    }
  });

  it("treats a blank half of the pair as partial, not as a silent fake fallback", () => {
    expect(readAgentConfig({ AGENT_BINARY: "  ", AGENT_MODEL: "qwen-coder" }).ok).toBe(false);
  });

  it("treats a wholly blank pair as unconfigured", () => {
    expect(okConfig({ AGENT_BINARY: "  ", AGENT_MODEL: "  " })).toEqual({ provider: undefined });
  });

  it("reads process.env by default", () => {
    // Asserts only that the default source is wired: this machine's env is not the test's business.
    expect(readAgentConfig()).toHaveProperty("ok");
  });
});

describe("resolveAgent", () => {
  const provider: Agent = createFakeAgent("provider reply");

  it("builds the provider adapter when a provider is configured and wired", () => {
    const resolved = resolveAgent({
      config: okConfig({ AGENT_BINARY: "local-agent", AGENT_MODEL: "qwen-coder" }),
      createProvider: (config) => {
        expect(config).toEqual({ binaryPath: "local-agent", modelIdentifier: "qwen-coder" });
        return provider;
      },
      fake
    });

    expect(resolved).toBe(provider);
  });

  it("stays on the fake when a configured provider has no factory wired yet", () => {
    const resolved = resolveAgent({
      config: okConfig({ AGENT_BINARY: "local-agent", AGENT_MODEL: "qwen-coder" }),
      fake
    });

    expect(resolved).toBe(fake);
  });

  it("uses the fake when nothing is configured, so a caller never needs an agent installed", () => {
    expect(resolveAgent({ config: okConfig({}), fake })).toBe(fake);
  });

  it("fails by name, never silently, when nothing is configured and no fake was supplied", async () => {
    const resolved = resolveAgent({ config: okConfig({}) });

    const error: unknown = await resolved.open({}).catch((caught: unknown) => caught);
    expect(isAgentError(error) ? error.code : undefined).toBe("agent_not_configured");
  });
});
