import { afterEach, describe, expect, it, vi } from "vitest";

import { createCoachAdapters, ollamaBaseUrl } from "./coachAdapters.js";
import { createFakeCoach } from "./fakeCoach.js";

// A minimal valid analyze request — enough to drive a tier's analyze() through its ChatModel boundary.
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

// Stub the network boundary so no real HTTP happens: an empty body makes each LLM tier's analyze parse
// nothing and degrade to its deterministic fake fallback — while recording which endpoint it reached.
function mockFetch(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue({ json: () => Promise.resolve({}) } as unknown as Response);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCoachAdapters", () => {
  it("keyless: strong is the deterministic fake (no cloud call), cheap is the local Ollama adapter", async () => {
    const fetchSpy = mockFetch();
    const adapters = createCoachAdapters(undefined);

    // Strong with no key is the fake: analyze resolves deterministically with no network call.
    const strongResult = await adapters.strong.analyze(analyzeRequest);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(strongResult).toEqual(await createFakeCoach().analyze(analyzeRequest));

    // Cheap is the real local adapter: its analyze reaches the local Ollama endpoint.
    await adapters.cheap.analyze(analyzeRequest);
    expect(fetchSpy).toHaveBeenCalledWith(`${ollamaBaseUrl}/api/generate`, expect.anything());
  });

  it("treats a blank key like no key: strong stays the fake", async () => {
    const fetchSpy = mockFetch();
    const adapters = createCoachAdapters("");

    await adapters.strong.analyze(analyzeRequest);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with a key: strong is the cloud adapter (reaches the cloud endpoint)", async () => {
    const fetchSpy = mockFetch();
    const adapters = createCoachAdapters("sk-test", "llama3.1:8b");

    await adapters.strong.analyze(analyzeRequest);
    expect(fetchSpy).toHaveBeenCalledWith("https://api.openai.com/v1/responses", expect.anything());
  });
});
