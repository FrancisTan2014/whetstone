import { describe, expect, it } from "vitest";

import {
  isWorkLanguage,
  isWorkType,
  normalizeWorkLanguage,
  workLanguageLabels,
  workLanguages,
  workTypes
} from "./work.js";

describe("work types", () => {
  it("recognizes the supported work types only", () => {
    for (const type of workTypes) {
      expect(isWorkType(type)).toBe(true);
    }
    expect(isWorkType("memoir")).toBe(false);
    expect(isWorkType(undefined)).toBe(false);
  });
});

describe("work languages", () => {
  it("recognizes the three supported languages only", () => {
    for (const language of workLanguages) {
      expect(isWorkLanguage(language)).toBe(true);
    }
    expect(isWorkLanguage("fr")).toBe(false);
    expect(isWorkLanguage("zh-Hans")).toBe(false);
    expect(isWorkLanguage(null)).toBe(false);
  });

  it("maps every language to a display label", () => {
    expect(workLanguageLabels["zh-CN"]).toContain("Simplified");
    expect(workLanguageLabels["zh-TW"]).toContain("Traditional");
    expect(workLanguageLabels.en).toBe("English");
  });
});

describe("normalizeWorkLanguage", () => {
  it("maps English and its regional variants to en", () => {
    expect(normalizeWorkLanguage("en")).toBe("en");
    expect(normalizeWorkLanguage("EN-US")).toBe("en");
    expect(normalizeWorkLanguage("en-GB")).toBe("en");
  });

  it("maps Traditional Chinese variants to zh-TW", () => {
    expect(normalizeWorkLanguage("zh-TW")).toBe("zh-TW");
    expect(normalizeWorkLanguage("zh-Hant")).toBe("zh-TW");
    expect(normalizeWorkLanguage("zh-HK")).toBe("zh-TW");
    expect(normalizeWorkLanguage("zh-MO")).toBe("zh-TW");
  });

  it("maps Simplified Chinese variants to zh-CN", () => {
    expect(normalizeWorkLanguage("zh")).toBe("zh-CN");
    expect(normalizeWorkLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeWorkLanguage("zh-Hans")).toBe("zh-CN");
    expect(normalizeWorkLanguage("zh-SG")).toBe("zh-CN");
  });

  it("maps unknown, blank, and und tags to en", () => {
    expect(normalizeWorkLanguage("und")).toBe("en");
    expect(normalizeWorkLanguage("fr")).toBe("en");
    expect(normalizeWorkLanguage("  ")).toBe("en");
  });

  it("trims surrounding whitespace before classifying (mirrors the data migration)", () => {
    expect(normalizeWorkLanguage(" zh-Hant ")).toBe("zh-TW");
    expect(normalizeWorkLanguage("zh-CN ")).toBe("zh-CN");
    expect(normalizeWorkLanguage("  EN  ")).toBe("en");
  });
});
