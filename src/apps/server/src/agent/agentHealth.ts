import type { AgentConfig } from "./agentConfig.js";
import type { AgentProbe, CliAgentConfig } from "./cliAgent.js";

// A boot-time report of whether a local agent is configured and whether it actually answers its
// readiness probe. This only *reports*: `resolveAgent` already falls back to the deterministic fake, so
// a missing or broken agent CLI never crashes startup — it degrades the seam to unavailable. Without
// this, a misconfigured provider would only be discovered by the first caller to fail, exactly the
// silent degrade `checkSpeechHealth` was added to end.

export type AgentHealthStatus = "fake" | "ready" | "unavailable";

export type AgentHealthReport = Readonly<{
  message: string;
  // The identifier the provider reported at the probe, or undefined when none answered.
  provider: string | undefined;
  // Whether the provider can resume conversation state across turns. False whenever nothing answered.
  sessions: boolean;
  status: AgentHealthStatus;
}>;

export type AgentHealthDependencies = Readonly<{
  config: AgentConfig;
  // The readiness probe for a configured provider. A rejection (missing binary, wrong contract) is
  // treated as unavailable so this check never throws on boot.
  probe: (config: CliAgentConfig) => Promise<AgentProbe>;
}>;

export async function checkAgentHealth(
  dependencies: AgentHealthDependencies
): Promise<AgentHealthReport> {
  const { provider } = dependencies.config;

  if (provider === undefined) {
    return {
      message:
        "No local agent is configured - the agent seam uses the deterministic fake. Set AGENT_BINARY + AGENT_MODEL to enable one (see docs/AGENT.md).",
      provider: undefined,
      sessions: false,
      status: "fake"
    };
  }

  const reported = await dependencies.probe(provider).catch(() => undefined);
  if (reported === undefined) {
    return {
      message:
        "The configured local agent did not answer its readiness probe - the agent seam is unavailable and the server still starts. Check AGENT_BINARY + AGENT_MODEL against docs/AGENT.md.",
      provider: undefined,
      sessions: false,
      status: "unavailable"
    };
  }

  const sessionSupport = reported.sessions
    ? "it can resume conversation state"
    : "it takes one-shot turns only";
  return {
    message: `The local agent ${reported.provider} answered its readiness probe - ${sessionSupport}.`,
    provider: reported.provider,
    sessions: reported.sessions,
    status: "ready"
  };
}
