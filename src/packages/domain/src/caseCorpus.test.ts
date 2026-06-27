import { describe, expect, it } from "vitest";

import { caseCorpus, getCorpusDomain } from "./caseCorpus.js";

describe("caseCorpus", () => {
  it("ships roughly 5 domains, each with roughly 3 cases of 6-10 chunks", () => {
    expect(caseCorpus.length).toBeGreaterThanOrEqual(5);

    for (const domain of caseCorpus) {
      expect(domain.cases.length).toBeGreaterThanOrEqual(3);
      for (const theCase of domain.cases) {
        expect(theCase.chunks.length).toBeGreaterThanOrEqual(6);
        expect(theCase.chunks.length).toBeLessThanOrEqual(10);
      }
    }
  });

  it("gives every domain a weight in (0, 1] and a name", () => {
    for (const domain of caseCorpus) {
      expect(domain.weight).toBeGreaterThan(0);
      expect(domain.weight).toBeLessThanOrEqual(1);
      expect(domain.name.trim().length).toBeGreaterThan(0);
    }
  });

  it("uses globally unique ids, namespaced by their parent", () => {
    const domainIds = new Set<string>();
    const caseIds = new Set<string>();
    const chunkIds = new Set<string>();

    for (const domain of caseCorpus) {
      expect(domainIds.has(domain.id)).toBe(false);
      domainIds.add(domain.id);

      for (const theCase of domain.cases) {
        expect(theCase.id.startsWith(`${domain.id}.`)).toBe(true);
        expect(caseIds.has(theCase.id)).toBe(false);
        caseIds.add(theCase.id);
        expect(theCase.situation.trim().length).toBeGreaterThan(0);
        expect(theCase.communicativeFunction.trim().length).toBeGreaterThan(0);

        for (const chunk of theCase.chunks) {
          expect(chunk.id.startsWith(`${theCase.id}.`)).toBe(true);
          expect(chunkIds.has(chunk.id)).toBe(false);
          chunkIds.add(chunk.id);
          expect(chunk.text.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("is deeply frozen so consumers cannot mutate the shared corpus", () => {
    expect(Object.isFrozen(caseCorpus)).toBe(true);
    expect(Object.isFrozen(caseCorpus[0])).toBe(true);
    expect(Object.isFrozen(caseCorpus[0]?.cases[0])).toBe(true);
    expect(Object.isFrozen(caseCorpus[0]?.cases[0]?.chunks[0])).toBe(true);
  });
});

describe("getCorpusDomain", () => {
  it("returns a domain by id", () => {
    expect(getCorpusDomain("kitchen")?.name).toBe("Kitchen & cooking");
  });

  it("returns undefined for an unknown id", () => {
    expect(getCorpusDomain("nope")).toBeUndefined();
  });
});
