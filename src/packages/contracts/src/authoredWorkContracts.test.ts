import { createTextDocument } from "@whetstone/document";
import { describe, expect, it } from "vitest";

import {
  parseAuthoredWorkDto,
  parseAuthoredWorkListDto,
  parseContinueWritingDto,
  parseCreateAuthoredWorkRequest,
  parseUpdateAuthoredWorkContentRequest
} from "./authoredWorkContracts.js";

const document = createTextDocument("A first line.");

const summary = {
  createdAt: "2026-07-01T10:00:00.000Z",
  entryId: "work-1",
  language: "en" as const,
  title: "My essay",
  updatedAt: "2026-07-01T11:00:00.000Z",
  workType: "essay" as const
};

describe("parseCreateAuthoredWorkRequest", () => {
  it("accepts a title, language, and work type", () => {
    const request = { language: "zh-CN" as const, title: "随笔", workType: "blog_post" as const };
    expect(parseCreateAuthoredWorkRequest(request)).toEqual(request);
  });

  it("rejects a blank title", () => {
    expect(() =>
      parseCreateAuthoredWorkRequest({ language: "en", title: "   ", workType: "essay" })
    ).toThrow();
  });

  it("rejects an unsupported language", () => {
    expect(() =>
      parseCreateAuthoredWorkRequest({ language: "fr", title: "Essai", workType: "essay" })
    ).toThrow();
  });

  it("rejects an unknown extra field", () => {
    expect(() =>
      parseCreateAuthoredWorkRequest({
        author: "me",
        language: "en",
        title: "Essay",
        workType: "essay"
      })
    ).toThrow();
  });
});

describe("parseUpdateAuthoredWorkContentRequest", () => {
  it("accepts a valid document", () => {
    expect(parseUpdateAuthoredWorkContentRequest({ document })).toEqual({ document });
  });

  it("rejects a malformed document", () => {
    expect(() =>
      parseUpdateAuthoredWorkContentRequest({ document: { type: "not-a-doc" } })
    ).toThrow();
  });
});

describe("parseAuthoredWorkDto", () => {
  it("round-trips a full authored work with its document", () => {
    const dto = { ...summary, document, unitEntryId: "unit-1" };
    expect(parseAuthoredWorkDto(dto)).toEqual(dto);
  });
});

describe("parseAuthoredWorkListDto", () => {
  it("accepts a list of authored-work summaries", () => {
    const dto = { works: [summary] };
    expect(parseAuthoredWorkListDto(dto)).toEqual(dto);
  });
});

describe("parseContinueWritingDto", () => {
  it("accepts the most recent authored work", () => {
    expect(parseContinueWritingDto({ work: summary })).toEqual({ work: summary });
  });

  it("accepts a null work when nothing is authored yet", () => {
    expect(parseContinueWritingDto({ work: null })).toEqual({ work: null });
  });
});
