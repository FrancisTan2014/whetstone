import { tmpdir } from "node:os";
import { join } from "node:path";

// Config resolution for the warm Copilot SDK runtime (#923). Kept separate from `copilotSdkAgent.ts`
// and free of any `@github/copilot-sdk` import so the operator-facing precedence/validation rules are
// testable with no SDK involved, exactly like `agentConfig.ts` does for the one-shot CLI provider.
//
// This is deliberately NOT the provider-neutral `AGENT_BINARY`/`AGENT_MODEL` pair `agentConfig.ts`
// resolves: this seam speaks to one specific vendor SDK (the issue's own outcome names "Copilot SDK"),
// so its env vars are named for that vendor rather than pretending to be provider-neutral.

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

const reasoningEfforts: ReadonlyArray<ReasoningEffort> = ["low", "medium", "high", "xhigh", "max"];

// The fixed defaults named by the issue: an operator overrides either half independently.
export const defaultCopilotModel = "gpt-5.4";
export const defaultCopilotReasoningEffort: ReasoningEffort = "high";

export type CopilotSdkConfig = Readonly<{
  model: string;
  reasoningEffort: ReasoningEffort;
  // Where the runtime keeps its own session state/config (`COPILOT_HOME` on the spawned process).
  // Scoped to this seam so it never shares - or silently depends on - a developer's personal
  // `~/.copilot` directory from an interactive Copilot CLI session.
  copilotHome: string;
}>;

export type CopilotSdkConfigError = Readonly<{
  message: string;
  remedy: string;
}>;

export type CopilotSdkConfigResult =
  | Readonly<{ ok: true; config: CopilotSdkConfig }>
  | Readonly<{ ok: false; error: CopilotSdkConfigError }>;

const remedy =
  "Set AGENT_COPILOT_REASONING_EFFORT to one of low, medium, high, xhigh, max (or unset it for the " +
  `default "${defaultCopilotReasoningEffort}"). See docs/AGENT.md.`;

function trimmedOrUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function isReasoningEffort(value: string): value is ReasoningEffort {
  return (reasoningEfforts as ReadonlyArray<string>).includes(value);
}

// The scratch directory this seam's runtime uses when the operator names none. A fixed, seam-owned
// subdirectory of the OS temp dir rather than the SDK's own `~/.copilot` default, so a warm runtime
// started by the server never reads or writes a developer's personal Copilot CLI session state.
function defaultCopilotHome(): string {
  return join(tmpdir(), "whetstone-copilot-sdk");
}

// Resolve this seam's config from env. Unlike `readAgentConfig`, there is no "unconfigured" outcome:
// the issue names fixed, sensible defaults for every field, so this always activates once the imminent
// consumer (#924) is wired - the only way to fail here is an operator-supplied override this runtime
// cannot honor.
export function readCopilotSdkConfig(env: NodeJS.ProcessEnv = process.env): CopilotSdkConfigResult {
  const model = trimmedOrUndefined(env.AGENT_COPILOT_MODEL) ?? defaultCopilotModel;
  const rawEffort = trimmedOrUndefined(env.AGENT_COPILOT_REASONING_EFFORT);
  const copilotHome = trimmedOrUndefined(env.AGENT_COPILOT_HOME) ?? defaultCopilotHome();

  if (rawEffort !== undefined && !isReasoningEffort(rawEffort)) {
    return {
      error: {
        message: `AGENT_COPILOT_REASONING_EFFORT "${rawEffort}" is not a reasoning effort this seam recognizes.`,
        remedy
      },
      ok: false
    };
  }

  return {
    config: {
      copilotHome,
      model,
      reasoningEffort: rawEffort ?? defaultCopilotReasoningEffort
    },
    ok: true
  };
}
