import { describe, expect, it, vi } from "vitest";

import { AgentError } from "../agent/agentFailure.js";
import { createFakeAgent } from "../agent/fakeAgent.js";
import type { Agent, AgentSession } from "../agent/agentSession.js";

import { agentJsonModeUnsupportedMessage, createAgentModel } from "./agentModel.js";

// A stub session that records its own lifecycle, so a test can prove the conversation is closed on
// every path — including the one where the turn rejects.
function trackedAgent(
  send: (prompt: string) => Promise<{ text: string }>
): Readonly<{ agent: Agent; closes: number; opened: Array<{ instructions?: string }> }> {
  const state = { closes: 0, opened: [] as Array<{ instructions?: string }> };
  const session: AgentSession = {
    close: () => {
      state.closes += 1;
      return Promise.resolve();
    },
    send
  };
  return {
    agent: {
      open: (config) => {
        state.opened.push(config);
        return Promise.resolve(session);
      }
    },
    get closes() {
      return state.closes;
    },
    opened: state.opened
  };
}

describe("createAgentModel", () => {
  it("opens a conversation, takes one turn, and returns the agent's text verbatim", async () => {
    const model = createAgentModel(createFakeAgent((prompt) => `heard: ${prompt}`));

    await expect(model("tidy this transcript")).resolves.toBe("heard: tidy this transcript");
  });

  it("returns the text unchanged, so the seam never reshapes a provider's answer", async () => {
    const model = createAgentModel(createFakeAgent("  spaced\n\nreply  "));

    await expect(model("prompt")).resolves.toBe("  spaced\n\nreply  ");
  });

  it("closes the conversation after a successful turn", async () => {
    const tracked = trackedAgent(() => Promise.resolve({ text: "answer" }));
    const model = createAgentModel(tracked.agent);

    await expect(model("prompt")).resolves.toBe("answer");
    expect(tracked.closes).toBe(1);
  });

  it("closes the conversation when the turn rejects, and propagates the named failure", async () => {
    // A leaked session would let a later completion silently continue an abandoned conversation.
    const tracked = trackedAgent(() =>
      Promise.reject(new AgentError("agent_exit_failed", "the CLI exited with code 1"))
    );
    const model = createAgentModel(tracked.agent);

    const error: unknown = await model("prompt").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe("agent_exit_failed");
    expect(tracked.closes).toBe(1);
  });

  it("propagates a failure to open (an unconfigured or unprobeable provider) without inventing text", async () => {
    const agent: Agent = {
      open: () =>
        Promise.reject(
          new AgentError("agent_probe_failed", "the provider did not answer its probe")
        )
    };

    await expect(createAgentModel(agent)("prompt")).rejects.toThrowError(AgentError);
  });

  it("gives each completion its own conversation, so prompts never bleed together", async () => {
    const tracked = trackedAgent((prompt) => Promise.resolve({ text: prompt }));
    const model = createAgentModel(tracked.agent);

    await model("first");
    await model("second");

    expect(tracked.opened).toEqual([{}, {}]);
    expect(tracked.closes).toBe(2);
  });

  it("fails by name when a caller requests JSON mode, instead of silently returning prose", async () => {
    const open = vi.fn();
    const model = createAgentModel({ open });

    await expect(model("prompt", { json: true })).rejects.toThrowError(
      agentJsonModeUnsupportedMessage
    );
    // Rejected before any provider is touched: the request is unsatisfiable, not a failed turn.
    expect(open).not.toHaveBeenCalled();
  });

  it("runs normally for a prose caller that passes options without JSON mode", async () => {
    const model = createAgentModel(createFakeAgent("tidied"));

    await expect(model("prompt", { json: false })).resolves.toBe("tidied");
    await expect(model("prompt", {})).resolves.toBe("tidied");
  });
});
