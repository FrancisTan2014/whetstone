import { describe, expect, it } from "vitest";

import { isAgentError } from "./agentFailure.js";
import { createFakeAgent } from "./fakeAgent.js";

describe("createFakeAgent", () => {
  it("answers every turn with the scripted reply, with no process or model", async () => {
    const session = await createFakeAgent("scripted reply").open({});

    await expect(session.send("first")).resolves.toEqual({ text: "scripted reply" });
    await expect(session.send("second")).resolves.toEqual({ text: "scripted reply" });
  });

  it("scripts a whole conversation as a deterministic function of the prompt", async () => {
    const session = await createFakeAgent((prompt) => `heard: ${prompt}`).open({
      instructions: "Be terse."
    });

    await expect(session.send("first")).resolves.toEqual({ text: "heard: first" });
    await expect(session.send("second")).resolves.toEqual({ text: "heard: second" });
  });

  it("enforces the port's closed-session rule, so it is no more permissive than a real provider", async () => {
    const session = await createFakeAgent("reply").open({});
    await session.close();

    const error: unknown = await session.send("again").catch((caught: unknown) => caught);
    expect(isAgentError(error) ? error.code : undefined).toBe("agent_session_closed");
  });

  it("gives each opened conversation its own lifecycle", async () => {
    const agent = createFakeAgent("reply");
    const closed = await agent.open({});
    await closed.close();

    const fresh = await agent.open({});
    await expect(fresh.send("hello")).resolves.toEqual({ text: "reply" });
  });
});
