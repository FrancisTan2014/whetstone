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

  it("parses a positive integer turn-timeout override when the fixture is enabled", () => {
    expect(
      readExplainFixtureConfig({
        AGENT_COPILOT_EXPLAIN_FIXTURE: "1",
        AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: "3000"
      }).turnTimeoutMs
    ).toBe(3000);
  });

  it("ignores an empty turn-timeout override when the fixture is enabled", () => {
    expect(
      readExplainFixtureConfig({
        AGENT_COPILOT_EXPLAIN_FIXTURE: "1",
        AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: "  "
      }).turnTimeoutMs
    ).toBeUndefined();
  });

  // #925 correction: `Number.parseInt` previously accepted a trailing fraction ("3.5" -> 3) or a
  // garbage suffix ("3000junk" -> 3000) silently. A full-string strict positive-integer check now
  // rejects each of these outright, with an actionable error.
  it.each(["0", "-5", "abc", "3.5", "3000junk", "1e3", "+3000"])(
    "rejects a non-strict-positive-integer override %j when the fixture is enabled",
    (value) => {
      expect(() =>
        readExplainFixtureConfig({
          AGENT_COPILOT_EXPLAIN_FIXTURE: "1",
          AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: value
        })
      ).toThrow(/positive integer/);
    }
  );

  it("rejects a turn-timeout override above the usable range when the fixture is enabled", () => {
    expect(() =>
      readExplainFixtureConfig({
        AGENT_COPILOT_EXPLAIN_FIXTURE: "1",
        AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: "150001"
      })
    ).toThrow(/at most/);
  });

  it("accepts a turn-timeout override at the top of the usable range when the fixture is enabled", () => {
    expect(
      readExplainFixtureConfig({
        AGENT_COPILOT_EXPLAIN_FIXTURE: "1",
        AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: "150000"
      }).turnTimeoutMs
    ).toBe(150_000);
  });

  // #925 correction: the override must be entirely irrelevant — never even inspected, and certainly
  // never crash ordinary startup — when the fixture itself is not genuinely engaged. This is the exact
  // scenario that previously broke ordinary AI-off startup on a stray/malformed env value, or could
  // silently override the real production 150s deadline on the REAL Copilot runtime.
  it.each(["abc", "3.5", "3000junk", "-5", "0", "999999999"])(
    "ignores a malformed/out-of-range turn-timeout override %j when the fixture is disabled, never throwing",
    (value) => {
      expect(readExplainFixtureConfig({ AGENT_COPILOT_EXPLAIN_TURN_TIMEOUT_MS: value })).toEqual({
        enabled: false
      });
    }
  );
});

async function openSession() {
  const agent = createExplainFixtureAgent();
  return agent.open({});
}

function payload(headword: string, language: string, context: string): string {
  return JSON.stringify({ context, headword, language });
}

describe("createExplainFixtureAgent", () => {
  // A real homograph (two genuinely unrelated etymologies) with the current marker chosen from the
  // REAL resolved context (never hardcoded) — the four cases below exercise every family/branch
  // combination so neither the first family nor the first branch is ever silently assumed correct.
  it("marks the riverside branch (first family, first branch) with no context markers", async () => {
    const session = await openSession();
    const turn = await session.send(payload("bank", "en", "they sat on the muddy bank"));
    const result = JSON.parse(turn.text) as {
      currentBranchId: string;
      currentFamilyId: string;
      families: ReadonlyArray<{ id: string }>;
    };

    expect(turn.model).toBe("fixture-copilot-model");
    expect(turn.reasoningEffort).toBe("fixture-high");
    expect(result.currentFamilyId).toBe("river");
    expect(result.currentBranchId).toBe("riverside");
    expect(result.families.map((family) => family.id)).toEqual(["river", "financial"]);
    await session.close();
  });

  it("marks the tilt branch (first family, SECOND branch) when context says a sharp maneuver", async () => {
    const session = await openSession();
    const turn = await session.send(payload("bank", "en", "a sharp maneuver toward the runway"));
    const result = JSON.parse(turn.text) as { currentFamilyId: string; currentBranchId: string };

    expect(result.currentFamilyId).toBe("river");
    expect(result.currentBranchId).toBe("tilt");
  });

  it("marks the institution branch (SECOND family, first branch) when context mentions an account", async () => {
    const session = await openSession();
    const turn = await session.send(payload("bank", "en", "she opened an account"));
    const result = JSON.parse(turn.text) as { currentFamilyId: string; currentBranchId: string };

    expect(result.currentFamilyId).toBe("financial");
    expect(result.currentBranchId).toBe("institution");
  });

  it("marks the deposit branch (SECOND family, SECOND branch) when context says to bank on someone", async () => {
    const session = await openSession();
    const turn = await session.send(payload("Bank", "en", "you can bank on him"));
    const result = JSON.parse(turn.text) as { currentFamilyId: string; currentBranchId: string };

    expect(result.currentFamilyId).toBe("financial");
    expect(result.currentBranchId).toBe("deposit");
  });

  it("returns a 'zh' single-family map, marking the phone-call branch when context says so", async () => {
    const session = await openSession();
    const turn = await session.send(payload("打", "zh", "我明天给你打电话。"));
    const result = JSON.parse(turn.text) as {
      currentBranchId: string;
      headword: string;
      families: ReadonlyArray<{ branches: ReadonlyArray<{ connection: string }> }>;
    };

    expect(turn.model).toBe("fixture-copilot-model");
    expect(result.currentBranchId).toBe("call");
    expect(result.headword).toBe("打");
    // #925 correction: every branch `connection` must be Chinese when the response language is zh,
    // never left over in English from an earlier, differently-languaged fixture.
    for (const branch of result.families[0]?.branches ?? []) {
      expect(branch.connection).toMatch(/[\u4e00-\u9fff]/);
    }
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
