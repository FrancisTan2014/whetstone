import { describe, expect, it } from "vitest";

import {
  parseCaseDetailDto,
  parseCaseListDto,
  parseDomainListDto
} from "./caseContracts.js";

const domain = { id: "kitchen", name: "Kitchen & cooking", weight: 0.9 };
const theCase = {
  communicativeFunction: "Proposing and negotiating a plan",
  domainId: "kitchen",
  id: "kitchen.meal_planning",
  situation: "Deciding what to cook for a meal"
};
const chunk = {
  caseId: "kitchen.meal_planning",
  gloss: null,
  id: "kitchen.meal_planning.whats_for_dinner",
  text: "What are we having for dinner?",
  usageNote: null
};
const mastery = {
  caseId: "kitchen.meal_planning",
  dueChunks: 0,
  learningChunks: 0,
  masteredChunks: 0,
  newChunks: 7,
  totalChunks: 7
};

describe("parseDomainListDto", () => {
  it("round-trips a domain list", () => {
    expect(parseDomainListDto({ domains: [domain] })).toEqual({ domains: [domain] });
  });

  it("rejects a domain missing its weight", () => {
    const { weight: _omitted, ...withoutWeight } = domain;
    expect(() => parseDomainListDto({ domains: [withoutWeight] })).toThrow();
  });
});

describe("parseCaseListDto", () => {
  it("round-trips a case list", () => {
    expect(parseCaseListDto({ cases: [theCase] })).toEqual({ cases: [theCase] });
  });

  it("rejects unknown fields", () => {
    expect(() => parseCaseListDto({ cases: [{ ...theCase, extra: true }] })).toThrow();
  });
});

describe("parseCaseDetailDto", () => {
  it("round-trips a case detail with chunks and mastery", () => {
    const detail = { case: theCase, chunks: [chunk], mastery };
    expect(parseCaseDetailDto(detail)).toEqual(detail);
  });

  it("preserves a chunk's gloss and usage note", () => {
    const detail = {
      case: theCase,
      chunks: [{ ...chunk, gloss: "to reveal a secret", usageNote: "a warm invitation" }],
      mastery
    };
    expect(parseCaseDetailDto(detail).chunks[0]).toMatchObject({
      gloss: "to reveal a secret",
      usageNote: "a warm invitation"
    });
  });

  it("rejects a mastery summary with a non-integer count", () => {
    expect(() =>
      parseCaseDetailDto({ case: theCase, chunks: [chunk], mastery: { ...mastery, totalChunks: 1.5 } })
    ).toThrow();
  });
});
