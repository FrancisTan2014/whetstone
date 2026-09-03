import { describe, expect, it } from "vitest";

import { readAgentConfig } from "./agentConfig.js";
import { checkAgentHealth } from "./agentHealth.js";
import type { AgentProbe } from "./cliAgent.js";

function configuredConfig() {
  const result = readAgentConfig({ AGENT_BINARY: "local-agent", AGENT_MODEL: "qwen-coder" });
  if (!result.ok) {
    throw new Error("expected a configured provider");
  }
  return result.config;
}

const probeNever = () => Promise.reject(new Error("the probe should not run"));

describe("checkAgentHealth", () => {
  it("reports the deterministic fake, and never probes, when nothing is configured", async () => {
    const report = await checkAgentHealth({ config: { provider: undefined }, probe: probeNever });

    expect(report.status).toBe("fake");
    expect(report.provider).toBeUndefined();
    expect(report.sessions).toBe(false);
    expect(report.message).toContain("AGENT_BINARY");
  });

  it("reports the provider identifier and session support when the probe answers", async () => {
    const probe = (): Promise<AgentProbe> => Promise.resolve({ provider: "qwen", sessions: true });

    const report = await checkAgentHealth({ config: configuredConfig(), probe });

    expect(report.status).toBe("ready");
    expect(report.provider).toBe("qwen");
    expect(report.sessions).toBe(true);
    expect(report.message).toContain("qwen");
    expect(report.message).toContain("resume conversation state");
  });

  it("says a one-shot provider takes single turns only", async () => {
    const probe = (): Promise<AgentProbe> =>
      Promise.resolve({ provider: "gemini", sessions: false });

    const report = await checkAgentHealth({ config: configuredConfig(), probe });

    expect(report.sessions).toBe(false);
    expect(report.message).toContain("one-shot turns only");
  });

  it("reports a failed probe as unavailable instead of throwing, so the server still starts", async () => {
    const probe = () => Promise.reject(new Error("spawn ENOENT"));

    const report = await checkAgentHealth({ config: configuredConfig(), probe });

    expect(report.status).toBe("unavailable");
    expect(report.provider).toBeUndefined();
    expect(report.sessions).toBe(false);
    expect(report.message).toContain("readiness probe");
    expect(report.message).toContain("still starts");
  });

  it("hands the configured provider to the probe", async () => {
    let seen: unknown;
    const probe = (config: unknown): Promise<AgentProbe> => {
      seen = config;
      return Promise.resolve({ provider: "qwen", sessions: false });
    };

    await checkAgentHealth({ config: configuredConfig(), probe });

    expect(seen).toEqual({ binaryPath: "local-agent", modelIdentifier: "qwen-coder" });
  });
});
