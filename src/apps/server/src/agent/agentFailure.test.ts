import { describe, expect, it } from "vitest";

import { AgentError, isAgentError } from "./agentFailure.js";

describe("AgentError", () => {
  it("carries a named failure code alongside the message", () => {
    const error = new AgentError("agent_timeout", "The local agent ran out of time.");

    expect(error.code).toBe("agent_timeout");
    expect(error.message).toBe("The local agent ran out of time.");
    expect(error.name).toBe("AgentError");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("isAgentError", () => {
  it("recognizes a seam failure so a caller can classify it without matching strings", () => {
    expect(isAgentError(new AgentError("agent_probe_failed", "no probe"))).toBe(true);
  });

  it.each([
    ["a plain Error", new Error("agent_probe_failed")],
    ["a thrown string", "agent_probe_failed"],
    ["undefined", undefined]
  ])("does not mistake %s for a seam failure", (_label, value) => {
    expect(isAgentError(value)).toBe(false);
  });
});
