import type { Agent } from "../agent/agentSession.js";
import type { LlmModel } from "./llmModel.js";

// The adapter that lets the local agent seam (#904) serve the shared `LlmModel` seam (#385), so a
// machine with no room for a resident local LLM can still run whetstone's optional AI utilities through
// an already-installed agentic CLI (#906). Both seams are prompt-in/text-out, so this is a genuinely
// thin mapping rather than a second model abstraction: one completion is a whole conversation —
// `open` -> `send` -> `close`.
//
// It stays provider-neutral, exactly like the seam beneath it: the caller passes an `Agent` and learns
// nothing about which CLI is installed. Failures propagate as the seam's own `AgentError` codes; this
// adapter never substitutes, salvages, or fabricates an answer, so a consumer's own fallback (diary
// tidy keeps the raw transcript) is what decides how a failed turn degrades.

// The one thing the two seams do not share. `LlmModel`'s `options.json` asks a provider for its
// structured-output mode, and the agent protocol has no such mode: a shim drives a vendor CLI whose
// answer is prose. Silently ignoring the flag would hand a JSON-expecting caller unparseable prose that
// looks like a model quality problem, so an unsupported request fails here, by name, before a session
// is even opened. Prose callers (diary tidy, lookup explain) never set it.
export const agentJsonModeUnsupportedMessage =
  "The local agent seam has no JSON output mode; call it without options.json (see docs/AGENT.md).";

export function createAgentModel(agent: Agent): LlmModel {
  return async (prompt, options) => {
    if (options?.json === true) {
      throw new Error(agentJsonModeUnsupportedMessage);
    }

    const session = await agent.open({});
    try {
      const turn = await session.send(prompt);
      return turn.text;
    } finally {
      // Closed on EVERY path, including a rejected turn. A one-shot provider has nothing resident to
      // tear down, but the port's contract is that a conversation ends — leaving it open would let a
      // later turn silently continue a conversation the caller already abandoned.
      await session.close();
    }
  };
}
