import { describe, expect, it, vi } from "vitest";

import { createCoachAdapters, type CoachModelFactories } from "./coachAdapters.js";
import { createFakeCoach } from "./fakeCoach.js";
import type { LlmModel } from "../llm/llmModel.js";

// A minimal valid analyze request — enough to drive a tier's analyze() through its LlmModel boundary.
const knobs = {
  challenge: "medium" as const,
  focus: "f",
  pace: "steady" as const,
  probeErrorPatterns: [],
  register: "neutral" as const,
  support: "medium" as const,
  targetBand: "intermediate" as const
};
const analyzeRequest = {
  communicativeFunction: "f",
  context: { profile: null, rankedChunks: [], recentOutcomes: [], relevantErrors: [] },
  history: [],
  knobs,
  situation: "s",
  targetChunks: [],
  words: []
};

// Fake the shared LlmModel seam — never the network. Each tier's model returns "" so its analyze parses
// nothing and degrades to the deterministic fake fallback, while we record that the tier reached the
// injected model (proving the seam is wired) and which factory built it.
function fakeFactories(): {
  cloudModel: ReturnType<typeof vi.fn>;
  factories: CoachModelFactories;
  localModel: ReturnType<typeof vi.fn>;
} {
  const localModel = vi.fn<LlmModel>(async () => "");
  const cloudModel = vi.fn<LlmModel>(async () => "");
  return {
    cloudModel,
    factories: { createCloud: vi.fn(() => cloudModel), createLocal: vi.fn(() => localModel) },
    localModel
  };
}

describe("createCoachAdapters", () => {
  it("keyless: cheap is the local seam adapter; strong is the deterministic fake (no cloud model built)", async () => {
    const { cloudModel, factories, localModel } = fakeFactories();
    const adapters = createCoachAdapters(undefined, () => {}, "llama3.1:8b", factories);

    // The cheap tier is built from the local factory for the configured model.
    expect(factories.createLocal).toHaveBeenCalledWith("llama3.1:8b");

    // Strong with no key is the fake: it grades deterministically without ever building/calling cloud.
    const strongResult = await adapters.strong.analyze(analyzeRequest);
    expect(factories.createCloud).not.toHaveBeenCalled();
    expect(cloudModel).not.toHaveBeenCalled();
    expect(strongResult).toEqual(await createFakeCoach().analyze(analyzeRequest));

    // Cheap routes analyze through the local seam adapter (then degrades to the fake on empty output).
    await adapters.cheap.analyze(analyzeRequest);
    expect(localModel).toHaveBeenCalledOnce();
  });

  it("treats a blank key like no key: strong stays the fake, no cloud model built", async () => {
    const { factories } = fakeFactories();
    const adapters = createCoachAdapters("", () => {}, "llama3.1:8b", factories);

    await adapters.strong.analyze(analyzeRequest);
    expect(factories.createCloud).not.toHaveBeenCalled();
  });

  it("with a key: strong is built from the cloud factory and routes analyze through it", async () => {
    const { cloudModel, factories } = fakeFactories();
    const adapters = createCoachAdapters("sk-test", () => {}, "llama3.1:8b", factories);

    expect(factories.createCloud).toHaveBeenCalledWith("sk-test");
    await adapters.strong.analyze(analyzeRequest);
    expect(cloudModel).toHaveBeenCalledOnce();
  });

  it("threads onFallback into the cheap tier so a degraded local call is reported with its model (#432)", async () => {
    const { factories } = fakeFactories(); // local model returns "" -> analyze parse fails -> fallback
    const onFallback = vi.fn();
    const adapters = createCoachAdapters(undefined, onFallback, "llama3.1:8b", factories);

    await adapters.cheap.analyze(analyzeRequest);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback).toHaveBeenCalledWith(
      expect.objectContaining({ method: "analyze", model: "llama3.1:8b" })
    );
  });

  it("defaults to the real model factories when none are injected (production wiring)", () => {
    // Building the adapters with the production defaults must not touch the network — the model is only
    // called on analyze — so constructing them exercises the default wiring without any I/O.
    expect(() => createCoachAdapters(undefined, () => {})).not.toThrow();
  });
});
