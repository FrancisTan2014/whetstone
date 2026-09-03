import { AgentError } from "./agentFailure.js";
import type { Agent } from "./agentSession.js";
import type { CliAgentConfig } from "./cliAgent.js";

// The local agent config seam (#904): whether a real provider is configured on this machine, following
// the `LOCAL_ASR_*` precedent exactly. `AGENT_BINARY` + `AGENT_MODEL` must be set together; anything
// less is either an explicit configuration error or the deterministic fake, so the server always boots
// and no caller depends on an agent CLI being installed.

export type AgentConfig = Readonly<{
  // The configured provider, or undefined when nothing is set (fall back to the deterministic fake).
  provider: CliAgentConfig | undefined;
}>;

// Exactly one half of the pair is a real misconfiguration, not a reason to silently drop to the fake:
// someone meant to enable a local agent and would otherwise never learn why it stayed off.
export type AgentConfigError = Readonly<{
  message: string;
  remedy: string;
}>;

export type AgentConfigResult =
  | Readonly<{ ok: true; config: AgentConfig }>
  | Readonly<{ ok: false; error: AgentConfigError }>;

const partialRemedy =
  "Set both AGENT_BINARY (the local agent executable) and AGENT_MODEL (its model identifier), or unset both to fall back to the deterministic fake. See docs/AGENT.md.";

function trimmedOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

// Resolve the agent config from env. Both keys present enables the provider-neutral CLI adapter;
// exactly one names the missing key as a startup configuration error; neither means the fake.
export function readAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfigResult {
  const binaryPath = trimmedOrUndefined(env.AGENT_BINARY);
  const modelIdentifier = trimmedOrUndefined(env.AGENT_MODEL);

  if (binaryPath !== undefined && modelIdentifier !== undefined) {
    return { config: { provider: { binaryPath, modelIdentifier } }, ok: true };
  }

  if (binaryPath !== undefined || modelIdentifier !== undefined) {
    const missingKey = binaryPath === undefined ? "AGENT_BINARY" : "AGENT_MODEL";
    return {
      error: {
        message: `The local agent is partially configured: ${missingKey} is not set.`,
        remedy: partialRemedy
      },
      ok: false
    };
  }

  return { config: { provider: undefined }, ok: true };
}

export type ResolveAgentDependencies = Readonly<{
  config: AgentConfig;
  // Builds the provider-neutral CLI adapter. Absent = not wired yet (stay on the fallback).
  createProvider?: (config: CliAgentConfig) => Agent;
  // The deterministic fallback used when no provider is configured. Absent = this caller has no safe
  // scripted answer, so every turn fails by name instead of fabricating one.
  fake?: Agent;
}>;

// An Agent that refuses to converse, by name. Better than a silent no-op for a caller that supplied no
// fake: "there is no local agent here" is a real, classifiable outcome.
const unavailableAgent: Agent = Object.freeze({
  open: () =>
    Promise.reject(
      new AgentError(
        "agent_not_configured",
        "No local agent is configured. Set AGENT_BINARY and AGENT_MODEL (see docs/AGENT.md)."
      )
    )
});

// Resolve the Agent to use: the configured provider's adapter when both a provider config and its
// factory are present, otherwise the caller's fake, otherwise the unavailable agent.
export function resolveAgent(dependencies: ResolveAgentDependencies): Agent {
  const { config, createProvider, fake } = dependencies;
  if (config.provider !== undefined && createProvider !== undefined) {
    return createProvider(config.provider);
  }
  return fake ?? unavailableAgent;
}
