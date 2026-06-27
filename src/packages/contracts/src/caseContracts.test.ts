import { describe, expect, it } from "vitest";

import {
  parseAuthorCaseRequest,
  parseAuthoredCaseDto,
  parseCaseDetailDto,
  parseCaseListDto,
  parseDomainListDto,
  parseReviewCaseRequest
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
      parseCaseDetailDto({
        case: theCase,
        chunks: [chunk],
        mastery: { ...mastery, totalChunks: 1.5 }
      })
    ).toThrow();
  });
});

describe("parseAuthorCaseRequest", () => {
  const request = {
    communicativeFunction: "Asking for directions",
    domainId: "errands",
    situation: "Lost in a new neighbourhood"
  };

  it("round-trips a valid brief", () => {
    expect(parseAuthorCaseRequest(request)).toEqual(request);
  });

  it("requires a non-blank domain id", () => {
    expect(() => parseAuthorCaseRequest({ ...request, domainId: "  " })).toThrow();
  });

  it("requires a non-blank situation", () => {
    expect(() => parseAuthorCaseRequest({ ...request, situation: "" })).toThrow();
  });
});

describe("parseReviewCaseRequest", () => {
  it("accepts an empty review (accept as-is)", () => {
    expect(parseReviewCaseRequest({})).toEqual({});
  });

  it("accepts an edit", () => {
    expect(parseReviewCaseRequest({ situation: "A clearer situation" })).toEqual({
      situation: "A clearer situation"
    });
  });

  it("rejects a blank edited field", () => {
    expect(() => parseReviewCaseRequest({ communicativeFunction: "  " })).toThrow();
  });
});

describe("parseAuthoredCaseDto", () => {
  const authored = {
    cached: false,
    case: theCase,
    chunks: [chunk],
    status: "needs_review"
  };

  it("round-trips an authored case", () => {
    expect(parseAuthoredCaseDto(authored)).toEqual(authored);
  });

  it("rejects an unknown status", () => {
    expect(() => parseAuthoredCaseDto({ ...authored, status: "draft" })).toThrow();
  });
});
