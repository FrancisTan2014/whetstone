import { describe, expect, it } from "vitest";

import {
  createExplainFixtureAgent,
  createExplainFixtureRuntime,
  readExplainFixtureConfig
} from "./explainFixtureAgent.js";

function delay(ms: number): Promise<"timed-out"> {
  return new Promise((resolve) => setTimeout(() => resolve("timed-out"), ms));
}

describe("readExplainFixtureConfig", () => {
  it("is disabled with no timeout override by default", () => {
    expect(readExplainFixtureConfig({})).toEqual({ enabled: false });
  });

  it.each(["1", "true", "TRUE"])("is enabled for %j", (value) => {
    expect(readExplainFixtureConfig({ AGENT_COPILOT_EXPLAIN_FIXTURE: value })).toEqual({
      enabled: true
    });
  });

  it.each(["0", "false", "", "no"])("is disabled for %j", (value) => {
    expect(readExplainFixtureConfig({ AGENT_COPILOT_EXPLAIN_FIXTURE: value }).enabled).toBe(false);
  });

  it("parses a positive integer turn-timeout override", () => {
    expect(
      readExplainFixtureConfig({ AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: "3000" }).turnTimeoutMs
    ).toBe(3000);
  });

  it("ignores an empty turn-timeout override", () => {
    expect(
      readExplainFixtureConfig({ AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: "  " }).turnTimeoutMs
    ).toBeUndefined();
  });

  it.each(["0", "-5", "abc"])("rejects a non-positive-integer override %j", (value) => {
    expect(() =>
      readExplainFixtureConfig({ AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: value })
    ).toThrow(/positive integer/);
  });
});

async function openSession() {
  const agent = createExplainFixtureAgent();
  return agent.open({});
}

function payload(headword: string, language: string, context: string): string {
  return JSON.stringify({ context, headword, language });
}

describe("createExplainFixtureAgent", () => {
  it("returns an 'en' homograph map, marking the device family/branch when context says so", async () => {
    const session = await openSession();
    const turn = await session.send(
      payload("spring", "en", "the coiled spring inside the clock snapped")
    );
    const result = JSON.parse(turn.text) as {
      currentBranchId: string;
      currentFamilyId: string;
      families: ReadonlyArray<{ id: string }>;
    };

    expect(turn.model).toBe("fixture-copilot-model");
    expect(turn.reasoningEffort).toBe("fixture-high");
    expect(result.currentFamilyId).toBe("device");
    expect(result.currentBranchId).toBe("device-leap");
    expect(result.families.map((family) => family.id)).toEqual(["season", "device"]);
    await session.close();
  });

  it("marks the season family/branch when context has no 'coiled' marker", async () => {
    const session = await openSession();
    const turn = await session.send(payload("Spring", "en", "spring finally arrived"));
    const result = JSON.parse(turn.text) as { currentFamilyId: string; currentBranchId: string };

    expect(result.currentFamilyId).toBe("season");
    expect(result.currentBranchId).toBe("season-arrival");
  });

  it("returns a 'zh' single-family map, marking the phone-call branch when context says so", async () => {
    const session = await openSession();
    const turn = await session.send(payload("打", "zh", "我明天给你打电话。"));
    const result = JSON.parse(turn.text) as { currentBranchId: string; headword: string };

    expect(turn.model).toBe("fixture-copilot-model");
    expect(result.currentBranchId).toBe("call");
    expect(result.headword).toBe("打");
  });

  it("marks the hit branch when context has no phone-call marker", async () => {
    const session = await openSession();
    const turn = await session.send(payload("打", "zh", "他轻轻打了一下桌子。"));
    const result = JSON.parse(turn.text) as { currentBranchId: string };

    expect(result.currentBranchId).toBe("hit");
  });

  it("fails the first 'breaktransport' attempt, then recovers on an identical retry", async () => {
    const session = await openSession();
    const prompt = payload("breakTransport", "en", "irrelevant context");

    await expect(session.send(prompt)).rejects.toThrow(/simulated transport failure/);

    const turn = await session.send(prompt);
    const result = JSON.parse(turn.text) as { currentFamilyId: string; headword: string };
    expect(result.currentFamilyId).toBe("core");
    expect(result.headword).toBe("breakTransport");
    // The recovered answer carries no provider attribution — proving the UI never fabricates it.
    expect(turn.model).toBeUndefined();
    expect(turn.reasoningEffort).toBeUndefined();
  });

  it("tracks retry attempts independently per distinct prompt", async () => {
    const session = await openSession();
    const promptA = payload("breakTransport", "en", "context A");
    const promptB = payload("breakTransport", "en", "context B");

    await expect(session.send(promptA)).rejects.toThrow();
    // A different exact prompt (different context) starts its own fresh attempt count.
    await expect(session.send(promptB)).rejects.toThrow();
    await session.send(promptA);
    await session.send(promptB);
  });

  it("returns deliberately invalid JSON for the 'badjson' magic headword", async () => {
    const session = await openSession();
    const turn = await session.send(payload("badjson", "en", "anything"));
    expect(() => JSON.parse(turn.text)).toThrow();
  });

  it("never resolves the 'timeouttest' magic headword within the caller's own deadline", async () => {
    const session = await openSession();
    const pending = session.send(payload("timeoutTest", "en", "anything"));

    const raced = await Promise.race([pending, delay(20)]);
    expect(raced).toBe("timed-out");
  });

  it("answers an unparseable prompt with empty (invalid) text", async () => {
    const session = await openSession();
    const turn = await session.send("not json at all");
    expect(turn.text).toBe("");
  });

  it("answers a JSON prompt missing required fields with empty (invalid) text", async () => {
    const session = await openSession();
    const turn = await session.send(JSON.stringify({ headword: "x" }));
    expect(turn.text).toBe("");
  });

  it("answers a non-object JSON prompt with empty (invalid) text", async () => {
    const session = await openSession();
    const turn = await session.send(JSON.stringify("just a string"));
    expect(turn.text).toBe("");
  });

  it("close() resolves with no side effects", async () => {
    const session = await openSession();
    await expect(session.close()).resolves.toBeUndefined();
  });
});

describe("createExplainFixtureRuntime", () => {
  it("wraps the fixture agent in the same {agent, dispose} shape the real runtime returns", async () => {
    const runtime = createExplainFixtureRuntime();
    const session = await runtime.agent.open({});
    const turn = await session.send(payload("打", "zh", "他打篮球。"));
    expect(JSON.parse(turn.text)).toMatchObject({ currentFamilyId: "core" });
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });
});
