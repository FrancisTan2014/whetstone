import { describe, expect, it, vi } from "vitest";

import type { CoachProvider } from "./coachProvider.js";
import { readCoachConfig, resolveCoach } from "./coachConfig.js";
import { defaultCostRouting } from "./coachRouter.js";

function stub(tag: string): CoachProvider {
  return {
    analyze: () =>
      Promise.resolve({
        chunkGrades: [],
        encouragement: tag,
        mistakes: [],
        upgrade: { native: tag, said: tag },
        wins: []
      }),
    authorCase: () => Promise.resolve({ chunks: [], communicativeFunction: tag, situation: tag }),
    converse: () => Promise.resolve({ say: tag }),
    gradeForScheduler: () => 0,
    judgeProduction: () =>
      Promise.resolve({
        category: "good",
        issues: [{ kind: "other", note: tag, severity: "minor" }],
        natural: 1
      }),
    proposeNext: () => Promise.resolve({ chunkId: null, cue: tag, target: tag })
  };
}

describe("readCoachConfig", () => {
  it("is absent-config-safe: no env yields the default routing and no key", () => {
    expect(readCoachConfig({})).toEqual({ apiKey: undefined, routing: defaultCostRouting });
  });

  it("reads an API key, treating a blank one as absent", () => {
    expect(readCoachConfig({ COACH_API_KEY: "sk-123" }).apiKey).toBe("sk-123");
    expect(readCoachConfig({ COACH_API_KEY: "   " }).apiKey).toBeUndefined();
  });

  it("applies per-call-type tier overrides", () => {
    const config = readCoachConfig({
      COACH_ANALYZE_TIER: "cheap",
      COACH_AUTHOR_TIER: "strong",
      COACH_CONVERSE_TIER: "cheap",
      COACH_JUDGE_TIER: "cheap",
      COACH_PROPOSE_TIER: "strong"
    });
    expect(config.routing).toEqual({
      analyze: "cheap",
      author: "strong",
      converse: "cheap",
      judge: "cheap",
      propose: "strong"
    });
  });

  it("rejects an unknown tier", () => {
    expect(() => readCoachConfig({ COACH_JUDGE_TIER: "medium" })).toThrow();
  });
});

describe("resolveCoach", () => {
  const fake = stub("fake");

  it("uses the fake when no key is configured", () => {
    const config = { apiKey: undefined, routing: defaultCostRouting };
    expect(
      resolveCoach({ config, createAdapters: () => ({ cheap: fake, strong: fake }), fake })
    ).toBe(fake);
  });

  it("uses the fake when a key is present but no adapter is wired", () => {
    const config = { apiKey: "sk-123", routing: defaultCostRouting };
    expect(resolveCoach({ config, fake })).toBe(fake);
  });

  it("builds the cost-routed real adapters from the key when both are present", async () => {
    const createAdapters = vi.fn((apiKey: string) => {
      expect(apiKey).toBe("sk-123");
      return { cheap: stub("cheap"), strong: stub("strong") };
    });
    const config = { apiKey: "sk-123", routing: defaultCostRouting };

    const coach = resolveCoach({ config, createAdapters, fake });

    expect(coach).not.toBe(fake);
    expect(createAdapters).toHaveBeenCalledOnce();
    // Default routing sends only analyze to the strong tier.
    const judgement = await coach.judgeProduction({
      context: { focus: "", recentTargets: [] },
      target: "x",
      transcript: "x"
    });
    expect(judgement.issues[0]?.note).toBe("cheap");
  });
});
